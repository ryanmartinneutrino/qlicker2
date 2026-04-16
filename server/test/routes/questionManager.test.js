import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import JSZip from 'jszip';
import { authenticatedRequest, createApp, createTestUser, getAuthToken } from '../helpers.js';
import Question from '../../src/models/Question.js';
import Response from '../../src/models/Response.js';

let app;

beforeEach(async (ctx) => {
  if (mongoose.connection.readyState !== 1) {
    ctx.skip();
    return;
  }
  app = await createApp();
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

async function createCourseAsProf(profToken, overrides = {}) {
  const res = await authenticatedRequest(app, 'POST', '/api/v1/courses', {
    token: profToken,
    payload: {
      name: 'Question Manager Course',
      deptCode: 'CS',
      courseNumber: '301',
      section: '001',
      semester: 'Fall 2026',
      ...overrides,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().course;
}

async function createSessionInCourse(profToken, courseId, overrides = {}) {
  const res = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/sessions`, {
    token: profToken,
    payload: {
      name: 'Question Manager Session',
      ...overrides,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().session;
}

async function createQuestion(profToken, overrides = {}) {
  const res = await authenticatedRequest(app, 'POST', '/api/v1/questions', {
    token: profToken,
    payload: {
      type: 2,
      content: '<p>Sample question</p>',
      plainText: 'Sample question',
      solution: '<p>Sample solution</p>',
      solution_plainText: 'Sample solution',
      ...overrides,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().question;
}

describe('question manager routes', () => {
  it('groups duplicate questions and exports a selected question group as a latex zip bundle', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    const prof = await createTestUser({ email: 'qm-prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const student = await createTestUser({ email: 'qm-student@example.com', roles: ['student'] });
    const course = await createCourseAsProf(profToken);
    const session = await createSessionInCourse(profToken, course._id);

    const libraryQuestion = await createQuestion(profToken, {
      courseId: course._id,
      content: '<p>What is 2 + 2?</p>',
      plainText: 'What is 2 + 2?',
      solution: '<p>4</p>',
      solution_plainText: '4',
    });

    const copyRes = await authenticatedRequest(app, 'POST', `/api/v1/questions/${libraryQuestion._id}/copy-to-session`, {
      token: profToken,
      payload: { sessionId: session._id },
    });
    expect(copyRes.statusCode).toBe(201);
    const sessionCopy = copyRes.json().question;

    await Response.create({
      attempt: 1,
      questionId: sessionCopy._id,
      studentUserId: String(student._id),
      answer: '4',
      submittedAt: new Date(),
    });

    const listRes = await authenticatedRequest(app, 'GET', '/api/v1/question-manager/questions', {
      token: profToken,
    });

    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().total).toBe(1);
    expect(listRes.json().entries).toHaveLength(1);

    const [entry] = listRes.json().entries;
    expect(entry.duplicateCount).toBe(2);
    expect(entry.responseBackedCount).toBe(1);
    expect(entry.sessionLinkedCount).toBe(1);
    expect(entry.requiresDetachedCopy).toBe(false);
    expect(entry.editableQuestionId).toBeTruthy();

    const exportRes = await authenticatedRequest(app, 'POST', '/api/v1/question-manager/questions/export-latex', {
      token: profToken,
      payload: {
        questionIds: [entry.editableQuestionId || entry.sourceQuestionId],
        includePoints: true,
      },
    });

    expect(exportRes.statusCode).toBe(200);
    expect(exportRes.headers['content-type']).toContain('application/zip');
    expect(exportRes.headers['content-disposition']).toContain('question-manager-export.zip');

    const zip = await JSZip.loadAsync(exportRes.rawPayload);
    const mainTex = await zip.file('main.tex').async('string');
    expect(mainTex).toContain('\\begin{questions}');
    expect(mainTex).toContain('What is 2 + 2?');
  });

  it('creates a detached editable copy for response-backed session questions', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    const prof = await createTestUser({ email: 'qm-detach-prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const student = await createTestUser({ email: 'qm-detach-student@example.com', roles: ['student'] });
    const course = await createCourseAsProf(profToken, { name: 'Detach Course' });
    const session = await createSessionInCourse(profToken, course._id, { name: 'Detach Session' });

    const sessionQuestion = await createQuestion(profToken, {
      courseId: course._id,
      sessionId: session._id,
      content: '<p>Session-only question</p>',
      plainText: 'Session-only question',
      solution: '<p>Detached answer</p>',
      solution_plainText: 'Detached answer',
    });

    await Response.create({
      attempt: 1,
      questionId: sessionQuestion._id,
      studentUserId: String(student._id),
      answer: 'Detached answer',
      submittedAt: new Date(),
    });

    const detachRes = await authenticatedRequest(app, 'POST', `/api/v1/question-manager/questions/${sessionQuestion._id}/editable-copy`, {
      token: profToken,
    });

    expect(detachRes.statusCode).toBe(201);
    expect(detachRes.json().detached).toBe(true);
    expect(detachRes.json().question.sessionId).toBe('');
    expect(detachRes.json().question.courseId).toBe('');
    expect(detachRes.json().question.questionManager.detachedFromQuestionId).toBe(sessionQuestion._id);

    const detachedQuestion = await Question.findById(detachRes.json().question._id).lean();
    expect(detachedQuestion.questionManager.detachedFromQuestionId).toBe(sessionQuestion._id);
    expect(detachedQuestion.owner).toBe(String(prof._id));
  });

  it('associates a standalone question-manager question with multiple courses by creating course copies', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    const prof = await createTestUser({ email: 'qm-assign-prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const firstCourse = await createCourseAsProf(profToken, {
      name: 'Mechanics',
      courseNumber: '201',
      section: '001',
    });
    const secondCourse = await createCourseAsProf(profToken, {
      name: 'Optics',
      courseNumber: '202',
      section: '002',
    });

    const standaloneQuestion = await createQuestion(profToken, {
      courseId: '',
      content: '<p>Standalone manager question</p>',
      plainText: 'Standalone manager question',
    });

    const assignRes = await authenticatedRequest(app, 'POST', '/api/v1/question-manager/questions/assign-courses', {
      token: profToken,
      payload: {
        questionIds: [standaloneQuestion._id],
        courseIds: [firstCourse._id, secondCourse._id],
      },
    });

    expect(assignRes.statusCode).toBe(200);
    expect(assignRes.json().createdCount).toBe(2);
    expect(assignRes.json().skippedCount).toBe(0);

    const listRes = await authenticatedRequest(app, 'GET', '/api/v1/question-manager/questions', {
      token: profToken,
    });

    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().total).toBe(1);
    const [entry] = listRes.json().entries;
    expect(entry.duplicateCount).toBe(3);
    expect(entry.standaloneCount).toBe(1);
    expect(entry.courses.map((course) => course._id).sort()).toEqual([firstCourse._id, secondCourse._id].sort());

    const questionCopies = await Question.find({
      'questionManager.fingerprint': entry.fingerprint,
    }).lean();
    expect(questionCopies.filter((question) => String(question.courseId || '').trim()).map((question) => question.courseId).sort())
      .toEqual([firstCourse._id, secondCourse._id].sort());
  });

  it('can return all matching question-manager groups in one response when requested', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    const prof = await createTestUser({ email: 'qm-all-prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);

    await createQuestion(profToken, {
      content: '<p>Question alpha</p>',
      plainText: 'Question alpha',
    });
    await createQuestion(profToken, {
      content: '<p>Question beta</p>',
      plainText: 'Question beta',
    });
    await createQuestion(profToken, {
      content: '<p>Question gamma</p>',
      plainText: 'Question gamma',
    });

    const pagedRes = await authenticatedRequest(app, 'GET', '/api/v1/question-manager/questions?page=2&limit=1', {
      token: profToken,
    });
    expect(pagedRes.statusCode).toBe(200);
    expect(pagedRes.json().entries).toHaveLength(1);
    expect(pagedRes.json().showingAll).toBe(false);

    const allRes = await authenticatedRequest(app, 'GET', '/api/v1/question-manager/questions?page=2&limit=1&all=true', {
      token: profToken,
    });
    expect(allRes.statusCode).toBe(200);
    expect(allRes.json().entries).toHaveLength(3);
    expect(allRes.json().total).toBe(3);
    expect(allRes.json().page).toBe(1);
    expect(allRes.json().showingAll).toBe(true);
  });
});
