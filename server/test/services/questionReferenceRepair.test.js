import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import Session from '../../src/models/Session.js';
import Question from '../../src/models/Question.js';
import Response from '../../src/models/Response.js';
import Grade from '../../src/models/Grade.js';
import { repairSessionQuestionReferences } from '../../src/services/questionReferenceRepair.js';

beforeEach((ctx) => {
  if (mongoose.connection.readyState !== 1) ctx.skip();
});

async function fixture() {
  const session = await Session.create({ name: 'Repair draft', courseId: 'course', status: 'hidden' });
  const question = await Question.create({
    creator: 'professor', courseId: 'course', sessionId: session._id,
    type: 4, content: 'Enter a number', correctNumerical: 42, toleranceNumerical: 0.1,
    sessionOptions: { points: 3, maxAttempts: 2, attemptWeights: [0.5, 1] },
  });
  await Question.collection.updateOne({ _id: question._id }, { $set: { solutionHtml: '<p>Legacy solution</p>' } });
  await Session.updateOne({ _id: session._id }, { $set: {
    questions: [question._id, question._id, question._id], currentQuestion: question._id,
  } });
  return { session, question };
}

describe('question reference repair', () => {
  it('audits without writing and repairs duplicate positions independently and idempotently', async () => {
    const { session, question } = await fixture();
    const before = await Session.collection.findOne({ _id: session._id });
    const source = await Question.collection.findOne({ _id: question._id });
    const audit = await repairSessionQuestionReferences({ sessionId: session._id });
    expect(audit).toMatchObject({ status: 'would-repair', replacements: [
      { position: 2, sourceQuestionId: question._id }, { position: 3, sourceQuestionId: question._id },
    ] });
    expect(await Session.collection.findOne({ _id: session._id })).toEqual(before);
    expect(await Question.countDocuments()).toBe(1);

    const result = await repairSessionQuestionReferences({ sessionId: session._id, apply: true });
    expect(result.status).toBe('repaired');
    const repaired = await Session.findById(session._id).lean();
    expect(repaired.questions[0]).toBe(question._id);
    expect(new Set(repaired.questions).size).toBe(3);
    expect(repaired.currentQuestion).toBe(question._id);
    expect(repaired.questionResponseCounts).toEqual(Object.fromEntries(repaired.questions.map((id) => [id, 0])));
    for (const id of repaired.questions.slice(1)) {
      expect(await Question.collection.findOne({ _id: id })).toMatchObject({
        originalQuestion: question._id, sessionId: session._id, courseId: 'course',
        correctNumerical: 42, toleranceNumerical: 0.1, solutionHtml: '<p>Legacy solution</p>',
        sessionOptions: { points: 3, maxAttempts: 2, attemptWeights: [0.5, 1], attempts: [] },
      });
    }
    expect(await Question.collection.findOne({ _id: question._id })).toEqual(source);
    expect((await repairSessionQuestionReferences({ sessionId: session._id, apply: true })).status).toBe('unchanged');
    expect(await Question.countDocuments()).toBe(3);
  });

  it('preserves the default zero-point value of legacy short-answer questions', async () => {
    const { session, question } = await fixture();
    await Question.collection.updateOne({ _id: question._id }, { $set: { type: 2 }, $unset: { sessionOptions: '' } });
    await repairSessionQuestionReferences({ sessionId: session._id, apply: true });
    const repaired = await Session.findById(session._id).lean();
    expect((await Question.findById(repaired.questions[1])).sessionOptions.points).toBe(0);
  });

  it('runs the CLI as a read-only audit with a session filter', async () => {
    const { session } = await fixture();
    const before = await Session.collection.findOne({ _id: session._id });
    const { stdout } = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL('../../scripts/repair-question-references.js', import.meta.url)),
      '--session', session._id,
    ], { env: { ...process.env, MONGO_URI: `mongodb://${mongoose.connection.host}:${mongoose.connection.port}/${mongoose.connection.name}` } });
    const reports = stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(reports[0]).toMatchObject({ sessionId: session._id, status: 'would-repair' });
    expect(reports[1].summary).toMatchObject({ mode: 'dry-run', scanned: 1 });
    expect(await Session.collection.findOne({ _id: session._id })).toEqual(before);
    expect(await Question.countDocuments()).toBe(1);
  });

  it('does not create collections when auditing an empty database', async () => {
    const databaseName = 'question_repair_empty_audit';
    const database = mongoose.connection.getClient().db(databaseName);
    expect(await database.listCollections().toArray()).toEqual([]);
    const result = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL('../../scripts/repair-question-references.js', import.meta.url)),
    ], { env: { ...process.env, MONGO_URI: `mongodb://${mongoose.connection.host}:${mongoose.connection.port}/${databaseName}` } }).catch((error) => error);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout).summary).toMatchObject({ scanned: 0, mode: 'dry-run' });
    expect(await database.listCollections().toArray()).toEqual([]);
  });

  it('copies foreign references and leaves the source session unchanged', async () => {
    const { session, question } = await fixture();
    const target = await Session.create({ name: 'Other draft', courseId: 'other-course', status: 'hidden', questions: [question._id], currentQuestion: question._id });
    const sourceBefore = await Session.findById(session._id).lean();
    expect((await repairSessionQuestionReferences({ sessionId: target._id, apply: true })).status).toBe('repaired');
    const repaired = await Session.findById(target._id).lean();
    expect(repaired.questions[0]).not.toBe(question._id);
    expect(repaired.currentQuestion).toBe(repaired.questions[0]);
    expect(await Session.findById(session._id).lean()).toEqual(sourceBefore);
  });

  it.each(['response', 'grade', 'foreign-grade', 'joined', 'visible', 'done', 'missing-question'])('leaves %s cases untouched for manual review', async (condition) => {
    const { session, question } = await fixture();
    if (condition === 'response') await Response.create({ questionId: question._id, studentUserId: 'student', attempt: 1, answer: 42 });
    if (condition === 'grade') await Grade.create({ sessionId: session._id, userId: 'student', automatic: false, value: 90 });
    if (condition === 'foreign-grade') await Grade.create({ sessionId: 'other-session', userId: 'student', marks: [{ questionId: question._id, points: 2, automatic: false }] });
    if (condition === 'joined') await Session.updateOne({ _id: session._id }, { $set: { joined: ['student'] } });
    if (condition === 'visible' || condition === 'done') await Session.updateOne({ _id: session._id }, { $set: { status: condition } });
    if (condition === 'missing-question') await Question.deleteOne({ _id: question._id });
    const sessionsBefore = await Session.collection.find({}).toArray();
    const questionsBefore = await Question.collection.find({}).toArray();
    const gradesBefore = await Grade.collection.find({}).toArray();
    const responsesBefore = await Response.collection.find({}).toArray();
    expect((await repairSessionQuestionReferences({ sessionId: session._id, apply: true })).status).toBe('manual-review');
    expect(await Session.collection.find({}).toArray()).toEqual(sessionsBefore);
    expect(await Question.collection.find({}).toArray()).toEqual(questionsBefore);
    expect(await Grade.collection.find({}).toArray()).toEqual(gradesBefore);
    expect(await Response.collection.find({}).toArray()).toEqual(responsesBefore);
  });

  it('cleans up copies if the inspected session changes before replacement', async () => {
    const { session } = await fixture();
    const update = Session.collection.updateOne.bind(Session.collection);
    const spy = vi.spyOn(Session.collection, 'updateOne').mockImplementationOnce(async (filter, changes) => {
      await update({ _id: session._id }, { $set: { name: 'Concurrent edit' } });
      return update(filter, changes);
    });
    try {
      expect((await repairSessionQuestionReferences({ sessionId: session._id, apply: true })).status).toBe('conflict');
      expect(await Question.countDocuments()).toBe(1);
      expect((await Session.findById(session._id)).name).toBe('Concurrent edit');
    } finally {
      spy.mockRestore();
    }
  });

  it('retains copies after an uncertain acknowledgement of a successful session update', async () => {
    const { session } = await fixture();
    const update = Session.collection.updateOne.bind(Session.collection);
    const spy = vi.spyOn(Session.collection, 'updateOne').mockImplementationOnce(async (filter, changes) => {
      await update(filter, changes);
      throw new Error('Lost acknowledgement');
    });
    try {
      await expect(repairSessionQuestionReferences({ sessionId: session._id, apply: true })).rejects.toThrow('Lost acknowledgement');
      const repaired = await Session.findById(session._id).lean();
      expect(new Set(repaired.questions).size).toBe(3);
      expect(await Question.countDocuments({ _id: { $in: repaired.questions } })).toBe(3);
      expect((await repairSessionQuestionReferences({ sessionId: session._id, apply: true })).status).toBe('unchanged');
    } finally {
      spy.mockRestore();
    }
  });

  it('cleans up earlier copies if creating a later copy fails', async () => {
    const { session } = await fixture();
    const before = await Session.findById(session._id).lean();
    const insert = Question.collection.insertOne.bind(Question.collection);
    const spy = vi.spyOn(Question.collection, 'insertOne')
      .mockImplementationOnce(insert)
      .mockRejectedValueOnce(new Error('Simulated insertion failure'));
    try {
      await expect(repairSessionQuestionReferences({ sessionId: session._id, apply: true })).rejects.toThrow('Simulated insertion failure');
      expect(await Question.countDocuments()).toBe(1);
      expect(await Session.findById(session._id).lean()).toEqual(before);
    } finally {
      spy.mockRestore();
    }
  });
});
