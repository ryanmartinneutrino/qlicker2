import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createApp, createTestUser, getAuthToken, authenticatedRequest } from '../helpers.js';
import Grade from '../../src/models/Grade.js';
import Response from '../../src/models/Response.js';
import Session from '../../src/models/Session.js';
import {
  getAnonymousParticipantId,
  isAnonymousParticipantId,
} from '../../src/utils/anonymousSession.js';

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

async function setupCourse({ studentCount = 2 } = {}) {
  const prof = await createTestUser({ email: 'anon-prof@example.com', roles: ['professor'] });
  const profToken = await getAuthToken(app, prof);
  const courseRes = await authenticatedRequest(app, 'POST', '/api/v1/courses', {
    token: profToken,
    payload: {
      name: 'Anonymous Course',
      deptCode: 'PSY',
      courseNumber: '200',
      section: '001',
      semester: 'Fall 2026',
    },
  });
  expect(courseRes.statusCode).toBe(201);
  const course = courseRes.json().course;

  const students = [];
  for (let index = 0; index < studentCount; index += 1) {
    const student = await createTestUser({
      email: `anon-student-${index}@example.com`,
      firstname: `Firstname${index}`,
      lastname: `Lastname${index}`,
      roles: ['student'],
    });
    const token = await getAuthToken(app, student);
    await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token,
      payload: { enrollmentCode: course.enrollmentCode },
    });
    students.push({ user: student, token });
  }

  return { prof, profToken, course, students };
}

async function createSession(profToken, courseId, payload = {}) {
  return authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/sessions`, {
    token: profToken,
    payload: { name: 'Anonymous Survey', ...payload },
  });
}

async function addMcQuestion(profToken, sessionId, courseId, content = 'How are you?') {
  const qRes = await authenticatedRequest(app, 'POST', '/api/v1/questions', {
    token: profToken,
    payload: {
      type: 0,
      content: `<p>${content}</p>`,
      plainText: content,
      sessionId,
      courseId,
      options: [
        { content: 'Good', correct: true },
        { content: 'Bad', correct: false },
      ],
    },
  });
  expect(qRes.statusCode).toBe(201);
  const addRes = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/questions`, {
    token: profToken,
    payload: { questionId: qRes.json().question._id },
  });
  expect(addRes.statusCode).toBe(200);
  const questionIds = addRes.json().session.questions;
  return questionIds[questionIds.length - 1];
}

async function startLiveQuestion(profToken, sessionId) {
  await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/start`, { token: profToken });
  const visibilityRes = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}/question-visibility`, {
    token: profToken,
    payload: { hidden: false, stats: false, correct: false },
  });
  expect(visibilityRes.statusCode).toBe(200);
}

function expectNoIdentity(payload, students) {
  const serialized = JSON.stringify(payload);
  students.forEach(({ user }) => {
    expect(serialized).not.toContain(String(user._id));
    expect(serialized).not.toContain(user.profile.firstname);
    expect(serialized).not.toContain(user.profile.lastname);
    expect(serialized).not.toContain(user.emails[0].address);
  });
}

describe('anonymous participant ids', () => {
  it('are stable per session, distinct across sessions, and not the user id', () => {
    const first = getAnonymousParticipantId('session-a', 'user-1');
    expect(first).toBe(getAnonymousParticipantId('session-a', 'user-1'));
    expect(first).not.toBe(getAnonymousParticipantId('session-b', 'user-1'));
    expect(first).not.toBe(getAnonymousParticipantId('session-a', 'user-2'));
    expect(first).not.toContain('user-1');
    expect(isAnonymousParticipantId(first)).toBe(true);
  });
});

describe('anonymous session settings', () => {
  it('creates anonymous sessions and rejects anonymous practice sessions', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course } = await setupCourse({ studentCount: 0 });

    const res = await createSession(profToken, course._id, { anonymous: true });
    expect(res.statusCode).toBe(201);
    expect(res.json().session.anonymous).toBe(true);

    const practiceRes = await createSession(profToken, course._id, {
      anonymous: true,
      quiz: true,
      practiceQuiz: true,
    });
    expect(practiceRes.statusCode).toBe(400);

    const toPracticeRes = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${res.json().session._id}`, {
      token: profToken,
      payload: { quiz: true, practiceQuiz: true },
    });
    expect(toPracticeRes.statusCode).toBe(400);
  });

  it('locks anonymity once a student has joined and clears stale grades when enabled', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course, students } = await setupCourse({ studentCount: 1 });
    const sessionId = (await createSession(profToken, course._id)).json().session._id;
    await Grade.create({ userId: String(students[0].user._id), courseId: course._id, sessionId });

    const enableRes = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}`, {
      token: profToken,
      payload: { anonymous: true },
    });
    expect(enableRes.statusCode).toBe(200);
    expect(enableRes.json().session.anonymous).toBe(true);
    expect(await Grade.countDocuments({ sessionId })).toBe(0);

    await addMcQuestion(profToken, sessionId, course._id);
    await startLiveQuestion(profToken, sessionId);
    await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/join`, {
      token: students[0].token,
      payload: {},
    });

    const disableRes = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}`, {
      token: profToken,
      payload: { anonymous: false },
    });
    expect(disableRes.statusCode).toBe(409);
    expect((await Session.findById(sessionId).lean()).anonymous).toBe(true);
  });

  it('copies the anonymous setting with the session', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course } = await setupCourse({ studentCount: 0 });
    const sessionId = (await createSession(profToken, course._id, { anonymous: true })).json().session._id;

    const copyRes = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/copy`, {
      token: profToken,
      payload: {},
    });
    expect(copyRes.statusCode).toBeLessThan(300);
    const copies = await Session.find({ courseId: course._id, _id: { $ne: sessionId } }).lean();
    expect(copies).toHaveLength(1);
    expect(copies[0].anonymous).toBe(true);
  });
});

describe('anonymous interactive sessions', () => {
  it('stores pseudonymous responses, allows one answer, and hides identities from instructors', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course, students } = await setupCourse({ studentCount: 2 });
    const sessionId = (await createSession(profToken, course._id, { anonymous: true })).json().session._id;
    const questionId = await addMcQuestion(profToken, sessionId, course._id);
    await startLiveQuestion(profToken, sessionId);

    for (const [index, { token }] of students.entries()) {
      const joinRes = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/join`, {
        token,
        payload: {},
      });
      expect(joinRes.statusCode).toBe(200);
      const respondRes = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/respond`, {
        token,
        payload: { answer: String(index % 2) },
      });
      expect(respondRes.statusCode).toBe(201);
    }

    const duplicateRes = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/respond`, {
      token: students[0].token,
      payload: { answer: '1' },
    });
    expect(duplicateRes.statusCode).toBe(409);

    const storedSession = await Session.findById(sessionId).lean();
    const storedResponses = await Response.find({ questionId }).lean();
    const realIds = students.map(({ user }) => String(user._id));
    expect(storedResponses).toHaveLength(2);
    storedResponses.forEach((response) => {
      expect(isAnonymousParticipantId(response.studentUserId)).toBe(true);
      expect(realIds).not.toContain(response.studentUserId);
      expect(response.submittedIpAddress).toBe('');
    });
    expect(storedSession.joined).toHaveLength(2);
    storedSession.joined.forEach((id) => expect(realIds).not.toContain(id));
    expect(storedSession.joinRecords).toHaveLength(0);

    const studentLiveRes = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${sessionId}/live`, {
      token: students[0].token,
    });
    expect(studentLiveRes.json().isJoined).toBe(true);
    expect(studentLiveRes.json().session.anonymous).toBe(true);
    expect(studentLiveRes.json().studentResponse).toEqual(expect.objectContaining({ answer: '0' }));

    const instructorLiveRes = await authenticatedRequest(
      app,
      'GET',
      `/api/v1/sessions/${sessionId}/live?includeStudentNames=true&includeJoinedStudents=true`,
      { token: profToken }
    );
    expect(instructorLiveRes.statusCode).toBe(200);
    expect(instructorLiveRes.json().session.joinedCount).toBe(2);
    expect(instructorLiveRes.json().session.joined).toBeUndefined();
    expect(instructorLiveRes.json().session.joinedStudents).toBeUndefined();
    expectNoIdentity(instructorLiveRes.json(), students);

    const admitRes = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/join/${realIds[0]}`, {
      token: profToken,
    });
    expect(admitRes.statusCode).toBe(400);

    const endRes = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/end`, {
      token: profToken,
      payload: { reviewable: true },
    });
    expect(endRes.statusCode).toBe(200);
    expect(endRes.json().nonAutoGradeableWarning).toBeNull();
    expect(await Grade.countDocuments({ sessionId })).toBe(0);

    const resultsRes = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${sessionId}/results`, {
      token: profToken,
    });
    expect(resultsRes.statusCode).toBe(200);
    const results = resultsRes.json();
    expect(results.session.anonymous).toBe(true);
    expect(results.anonymousSummary).toEqual({ respondentCount: 2, joinedCount: 2, enrolledCount: 2 });
    expect(results.studentResults.map((row) => row.studentId)).toEqual(['respondent-1', 'respondent-2']);
    expect(results.studentResults.map((row) => row.anonymousIndex)).toEqual([1, 2]);
    results.studentResults.forEach((row) => {
      const [response] = row.questionResults[0].responses;
      expect(response.studentUserId).toBe(row.studentId);
      expect(response).not.toHaveProperty('createdAt');
      expect(response).not.toHaveProperty('submittedIpAddress');
    });
    expect(results.studentResults.map((row) => row.questionResults[0].responses[0].answer).sort()).toEqual(['0', '1']);
    expectNoIdentity(results, students);
    expect(JSON.stringify(results)).not.toContain('anon_');

    const gradesRes = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${sessionId}/grades`, {
      token: profToken,
    });
    expect(gradesRes.json()).toEqual(expect.objectContaining({ anonymous: true, grades: [] }));

    const recalcRes = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/grades/recalculate`, {
      token: profToken,
      payload: {},
    });
    expect(recalcRes.statusCode).toBe(409);

    const gradebookRes = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}/grades`, {
      token: profToken,
    });
    expect(gradebookRes.statusCode).toBe(200);
    expect(JSON.stringify(gradebookRes.json())).not.toContain(sessionId);

    const studentReviewRes = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${sessionId}/review`, {
      token: students[1].token,
    });
    expect(studentReviewRes.statusCode).toBe(200);
    expect(studentReviewRes.json().session.anonymous).toBe(true);
    expect(studentReviewRes.json().grade).toBeNull();
    expect(studentReviewRes.json().responses[questionId]).toEqual([
      expect.objectContaining({ answer: '1' }),
    ]);

    const sessionRes = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${sessionId}`, {
      token: profToken,
    });
    expect(sessionRes.json().session.joinedCount).toBe(2);
    expect(sessionRes.json().session.joined).toBeUndefined();
    expect(sessionRes.json().session.joinRecords).toBeUndefined();
  });

  it('routes live events to joined students without exposing names to instructors', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { prof, profToken, course, students } = await setupCourse({ studentCount: 2 });
    const sessionId = (await createSession(profToken, course._id, { anonymous: true })).json().session._id;
    await addMcQuestion(profToken, sessionId, course._id);
    const shortAnswerRes = await authenticatedRequest(app, 'POST', '/api/v1/questions', {
      token: profToken,
      payload: {
        type: 2,
        content: '<p>Any comments?</p>',
        plainText: 'Any comments?',
        sessionId,
        courseId: course._id,
      },
    });
    await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/questions`, {
      token: profToken,
      payload: { questionId: shortAnswerRes.json().question._id },
    });
    const questionIds = (await Session.findById(sessionId).lean()).questions;
    await startLiveQuestion(profToken, sessionId);

    const joinSpy = vi.spyOn(app, 'wsSendToUsers');
    await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/join`, {
      token: students[0].token,
      payload: {},
    });
    const joinCall = joinSpy.mock.calls.find(([, event]) => event === 'session:participant-joined');
    expect(joinCall[2]).toEqual(expect.objectContaining({ joinedCount: 1, anonymous: true }));
    expect(joinCall[2].joinedStudent).toBeUndefined();

    const visibilityRes = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}/question-visibility`, {
      token: profToken,
      payload: { hidden: false, stats: true, correct: false },
    });
    expect(visibilityRes.statusCode).toBe(200);
    const visibilityCalls = joinSpy.mock.calls.filter(([, event]) => event === 'session:visibility-changed');
    const studentCall = visibilityCalls.find(([userIds]) => userIds.includes(String(students[0].user._id)));
    expect(studentCall).toBeDefined();
    // Only joined students receive session deltas.
    expect(visibilityCalls.some(([userIds]) => userIds.includes(String(students[1].user._id)))).toBe(false);

    const currentRes = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}/current`, {
      token: profToken,
      payload: { questionId: questionIds[1] },
    });
    expect(currentRes.statusCode).toBe(200);
    await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}/question-visibility`, {
      token: profToken,
      payload: { hidden: false, stats: true, correct: false },
    });

    joinSpy.mockClear();
    const respondRes = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/respond`, {
      token: students[0].token,
      payload: { answer: 'Private thought', answerWysiwyg: '<p>Private thought</p>' },
    });
    expect(respondRes.statusCode).toBe(201);
    const responseCalls = joinSpy.mock.calls.filter(([, event]) => event === 'session:response-added');
    const instructorResponseCall = responseCalls.find(([userIds]) => userIds.includes(String(prof._id)));
    expect(instructorResponseCall).toBeDefined();
    expect(instructorResponseCall[2].response).toEqual(expect.objectContaining({ answer: 'Private thought' }));
    expect(instructorResponseCall[2].response.studentName).toBeUndefined();
    expectNoIdentity(instructorResponseCall[2], students);

    joinSpy.mockClear();
    const sendToUserSpy = typeof app.wsSendToUser === 'function' ? vi.spyOn(app, 'wsSendToUser') : null;
    await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}/current`, {
      token: profToken,
      payload: { questionId: questionIds[0] },
    });
    await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}/current`, {
      token: profToken,
      payload: { questionId: questionIds[1] },
    });
    const questionChangedCalls = [
      ...joinSpy.mock.calls,
      ...(sendToUserSpy ? sendToUserSpy.mock.calls.map(([userId, event, payload]) => [[userId], event, payload]) : []),
    ].filter(([, event]) => event === 'session:question-changed');
    const ownResponseDelivery = questionChangedCalls.find(([userIds, , payload]) => (
      userIds.includes(String(students[0].user._id)) && payload.studentResponse
    ));
    expect(ownResponseDelivery?.[2].studentResponse).toEqual(expect.objectContaining({ answer: 'Private thought' }));
    const instructorSnapshot = questionChangedCalls.find(([userIds]) => userIds.includes(String(prof._id)));
    expectNoIdentity(instructorSnapshot[2], students);
  });
});

describe('anonymous quizzes', () => {
  it('allows one submission per student and keeps the course list status per student', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course, students } = await setupCourse({ studentCount: 2 });
    const now = Date.now();
    const sessionId = (await createSession(profToken, course._id, {
      anonymous: true,
      quiz: true,
      quizStart: new Date(now - (30 * 60 * 1000)).toISOString(),
      quizEnd: new Date(now + (30 * 60 * 1000)).toISOString(),
    })).json().session._id;
    const questionId = await addMcQuestion(profToken, sessionId, course._id);
    await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}`, {
      token: profToken,
      payload: { status: 'visible' },
    });

    const [first, second] = students;
    const quizRes = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${sessionId}/quiz`, { token: first.token });
    expect(quizRes.statusCode).toBe(200);
    expect(quizRes.json().session.anonymous).toBe(true);

    await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}/quiz-response`, {
      token: first.token,
      payload: { questionId, answer: '1' },
    });
    const updateRes = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}/quiz-response`, {
      token: first.token,
      payload: { questionId, answer: '0' },
    });
    expect(updateRes.statusCode).toBe(200);
    expect(await Response.countDocuments({ questionId })).toBe(1);

    const submitRes = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/submit`, { token: first.token });
    expect(submitRes.statusCode).toBe(200);
    expect(submitRes.json().session.quizSubmittedByCurrentUser).toBe(true);

    const resubmitRes = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/submit`, { token: first.token });
    expect(resubmitRes.statusCode).toBe(409);
    const reenterRes = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${sessionId}/quiz`, { token: first.token });
    expect(reenterRes.statusCode).toBe(403);
    const lateEditRes = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}/quiz-response`, {
      token: first.token,
      payload: { questionId, answer: '1' },
    });
    expect(lateEditRes.statusCode).toBe(403);

    const firstListRes = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}/sessions`, { token: first.token });
    const firstListed = firstListRes.json().sessions.find((entry) => entry._id === sessionId);
    expect(firstListed.quizSubmittedByCurrentUser).toBe(true);
    expect(firstListed.quizAllQuestionsAnsweredByCurrentUser).toBe(true);

    const secondListRes = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}/sessions`, { token: second.token });
    const secondListed = secondListRes.json().sessions.find((entry) => entry._id === sessionId);
    expect(secondListed.quizSubmittedByCurrentUser).toBe(false);
    expect(secondListed.quizHasResponsesByCurrentUser).toBe(false);

    const storedSession = await Session.findById(sessionId).lean();
    expect(storedSession.submittedQuiz).toEqual([getAnonymousParticipantId(sessionId, String(first.user._id))]);

    const profListRes = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}/sessions`, { token: profToken });
    const profListed = profListRes.json().sessions.find((entry) => entry._id === sessionId);
    expect(profListed.submittedCount).toBe(1);
    expect(profListed.submittedQuiz).toBeUndefined();
    expectNoIdentity(profListRes.json(), students);
  });
});
