import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createApp, createTestUser, getAuthToken, authenticatedRequest } from '../helpers.js';
import ActivityGrant from '../../src/models/ActivityGrant.js';
import ActivityShare from '../../src/models/ActivityShare.js';
import Course from '../../src/models/Course.js';
import Grade from '../../src/models/Grade.js';
import Question from '../../src/models/Question.js';
import Response from '../../src/models/Response.js';
import { getSessionParticipantId } from '../../src/utils/anonymousSession.js';
import Session from '../../src/models/Session.js';

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

async function fixture({ anonymous = false, quiz = true } = {}) {
  const professor = await createTestUser({ email: 'share-prof@example.com', roles: ['professor'] });
  const outsider = await createTestUser({ email: 'share-outsider@example.com', roles: ['student'] });
  const professorToken = await getAuthToken(app, professor);
  const outsiderToken = await getAuthToken(app, outsider);
  const courseResponse = await authenticatedRequest(app, 'POST', '/api/v1/courses', {
    token: professorToken,
    payload: {
      name: 'Survey Course', deptCode: 'SUR', courseNumber: '100',
      section: '001', semester: 'Fall 2026', allowSharedActivities: true,
    },
  });
  expect(courseResponse.statusCode).toBe(201);
  const course = courseResponse.json().course;
  const sessionResponse = await authenticatedRequest(app, 'POST', `/api/v1/courses/${course._id}/sessions`, {
    token: professorToken,
    payload: { name: 'External Survey', anonymous, quiz },
  });
  expect(sessionResponse.statusCode).toBe(201);
  const session = sessionResponse.json().session;
  return { professor, outsider, professorToken, outsiderToken, course, session };
}

async function issue(sessionId, professorToken, payload = {}) {
  return authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/activity-share`, {
    token: professorToken, payload,
  });
}

async function redeem(code, outsiderToken) {
  return authenticatedRequest(app, 'POST', '/api/v1/activity-codes/redeem', {
    token: outsiderToken, payload: { code },
  });
}

describe('activity code foundation', () => {
  it('issues a hashed code and an idempotent session-only grant without enrollment or grades', async () => {
    const { professorToken, outsiderToken, outsider, course, session } = await fixture();
    const issued = await issue(session._id, professorToken);
    expect(issued.statusCode).toBe(200);
    const code = issued.json().code;
    const status = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/activity-share`, { token: professorToken });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ enabled: true, code, expiresAt: issued.json().expiresAt });
    expect(code).toMatch(/^S-[A-HJ-NP-Z2-9]{10}$/);
    const share = await ActivityShare.findOne({ sessionId: session._id }).lean();
    expect(share.codeHash).not.toBe(code);
    expect(JSON.stringify(share)).not.toContain(code);

    const first = await redeem(code.toLowerCase(), outsiderToken);
    const second = await redeem(code, outsiderToken);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json()).toEqual({
      sessionId: session._id, courseId: course._id, name: session.name, quiz: true, anonymous: false,
    });
    expect(await ActivityGrant.countDocuments({ sessionId: session._id, userId: outsider._id })).toBe(1);
    const grant = await ActivityGrant.findOne({ sessionId: session._id, userId: outsider._id }).lean();
    expect(typeof grant._id).toBe('string');
    expect((await Session.findById(session._id).lean()).participationStarted).toBe(true);
    expect((await Course.findById(course._id).lean()).students).not.toContain(outsider._id);
    expect(await Grade.countDocuments({ sessionId: session._id, userId: outsider._id })).toBe(0);
    const sessionAccess = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}`, { token: outsiderToken });
    expect(sessionAccess.statusCode).toBe(403); // Hidden sessions stay hidden.

    const toggle = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${session._id}`, {
      token: professorToken, payload: { anonymous: true },
    });
    expect(toggle.statusCode).toBe(409);
  });

  it('keeps old hash-only codes redeemable but requires rotation to display them', async () => {
    const { professorToken, outsiderToken, session } = await fixture();
    const legacyCode = `S-${'A'.repeat(40)}`;
    const { hashActivityCode } = await import('../../src/services/activityAccess.js');
    await Session.updateOne({ _id: session._id }, { $set: { activityEverShared: true, activityAccessEnabled: true } });
    await ActivityShare.create({ sessionId: session._id, codeHash: hashActivityCode(legacyCode),
      expiresAt: new Date(Date.now() + 60_000) });
    const status = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/activity-share`, { token: professorToken });
    expect(status.json().enabled).toBe(true);
    expect(status.json().code).toBeNull();
    expect((await redeem(legacyCode, outsiderToken)).statusCode).toBe(200);
    const replacement = (await issue(session._id, professorToken)).json().code;
    expect(replacement).toMatch(/^S-[A-HJ-NP-Z2-9]{10}$/);
    const updated = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/activity-share`, { token: professorToken });
    expect(updated.json().code).toBe(replacement);
  });

  it('handles concurrent redemption as one grant', async () => {
    const { professorToken, outsiderToken, outsider, session } = await fixture();
    const code = (await issue(session._id, professorToken)).json().code;
    const responses = await Promise.all([
      redeem(code, outsiderToken), redeem(code, outsiderToken), redeem(code, outsiderToken),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200]);
    expect(await ActivityGrant.countDocuments({ sessionId: session._id, userId: outsider._id })).toBe(1);
  });

  it('rotates the code while preserving grants, then disables access', async () => {
    const { professorToken, outsiderToken, outsider, session } = await fixture({ anonymous: true });
    const firstCode = (await issue(session._id, professorToken)).json().code;
    expect((await redeem(firstCode, outsiderToken)).statusCode).toBe(200);
    const { hasActivityGrant } = await import('../../src/services/activityAccess.js');
    expect(await hasActivityGrant(session._id, outsider._id)).toBe(true);

    const secondCode = (await issue(session._id, professorToken)).json().code;
    expect(secondCode).not.toBe(firstCode);
    expect((await redeem(firstCode, outsiderToken)).statusCode).toBe(404);
    expect((await redeem(secondCode, outsiderToken)).statusCode).toBe(200);
    expect(await hasActivityGrant(session._id, outsider._id)).toBe(true);

    const disabled = await authenticatedRequest(app, 'DELETE', `/api/v1/sessions/${session._id}/activity-share`, {
      token: professorToken,
    });
    expect(disabled.statusCode).toBe(200);
    expect(await hasActivityGrant(session._id, outsider._id)).toBe(false);
    expect((await redeem(secondCode, outsiderToken)).statusCode).toBe(404);
    const replacementCode = (await issue(session._id, professorToken)).json().code;
    expect(await hasActivityGrant(session._id, outsider._id)).toBe(false);
    expect((await redeem(replacementCode, outsiderToken)).statusCode).toBe(200);
    expect(await hasActivityGrant(session._id, outsider._id)).toBe(true);
    expect((await Session.findById(session._id).lean()).participationStarted).toBe(true);
  });

  it('rejects non-instructor management, expired codes, and unknown codes without disclosing a course', async () => {
    const { professorToken, outsiderToken, session, course } = await fixture();
    expect((await issue(session._id, outsiderToken)).statusCode).toBe(403);
    const status = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/activity-share`, {
      token: outsiderToken,
    });
    expect(status.statusCode).toBe(403);
    expect((await issue(session._id, professorToken, { expiresAt: '2020-01-01T00:00:00.000Z' })).statusCode).toBe(400);
    const invalid = await redeem('S-' + 'A'.repeat(10), outsiderToken);
    expect(invalid.statusCode).toBe(404);
    expect(JSON.stringify(invalid.json())).not.toContain(course.name);
    expect(await ActivityGrant.countDocuments({ sessionId: session._id })).toBe(0);
    const validCode = (await issue(session._id, professorToken)).json().code;
    await ActivityShare.updateOne({ sessionId: session._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await redeem(validCode, outsiderToken)).statusCode).toBe(404);
  });
});


describe('anonymous activity code boundary', () => {
  it('locks an anonymous survey after outsider redemption without exposing the respondent', async () => {
    const { professorToken, outsiderToken, outsider, course, session } = await fixture({ anonymous: true });
    const code = (await issue(session._id, professorToken)).json().code;
    const redeemed = await redeem(code, outsiderToken);
    expect(redeemed.statusCode).toBe(200);
    expect(redeemed.json().anonymous).toBe(true);
    expect(JSON.stringify(redeemed.json())).not.toContain(outsider._id);
    const change = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${session._id}`, {
      token: professorToken, payload: { anonymous: false },
    });
    expect(change.statusCode).toBe(409);
    expect((await Course.findById(course._id).lean()).students).not.toContain(outsider._id);
    expect((await Session.findById(session._id).lean()).joined).toEqual([]);
  });
});


describe('outside activity participation', () => {
  async function addQuestion({ session, course, professor, type = 2 }) {
    const question = await Question.create({
      type, creator: professor._id, sessionId: session._id, courseId: course._id,
      content: '<p>Survey question</p>', plainText: 'Survey question',
      options: type === 0 ? [{ content: 'Yes', correct: true }, { content: 'No', correct: false }] : [],
      sessionOptions: { hidden: false, attempts: [{ number: 1, closed: false }] },
    });
    await Session.updateOne({ _id: session._id }, { $addToSet: { questions: question._id } });
    return question;
  }

  for (const anonymous of [false, true]) {
    it(`${anonymous ? 'anonymous' : 'named'} outside quiz keeps response identity and grade isolation`, async () => {
      const context = await fixture({ anonymous });
      const { professor, professorToken, outsider, outsiderToken, course, session } = context;
      const questions = [
        await addQuestion(context), await addQuestion(context),
      ];
      const now = Date.now();
      await Session.updateOne({ _id: session._id }, { $set: {
        status: 'visible', quizStart: new Date(now - 60000), quizEnd: new Date(now + 600000),
      } });
      const code = (await issue(session._id, professorToken)).json().code;
      expect((await redeem(code, outsiderToken)).statusCode).toBe(200);
      const opened = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/quiz`, { token: outsiderToken });
      expect(opened.statusCode).toBe(200);
      expect(opened.json().questions).toHaveLength(2);
      expect(opened.json().session.quizExtensions).toBeUndefined();
      for (const question of questions) {
        const saved = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${session._id}/quiz-response`, {
          token: outsiderToken, payload: { questionId: question._id, answer: 'survey answer' },
        });
        expect(saved.statusCode).toBe(200);
      }
      const submitted = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/submit`, { token: outsiderToken });
      expect(submitted.statusCode).toBe(200);
      const response = await Response.findOne({ questionId: questions[0]._id }).lean();
      expect(response.studentUserId === outsider._id).toBe(!anonymous);
      expect(await Grade.countDocuments({ sessionId: session._id })).toBe(0);
      await Session.updateOne({ _id: session._id }, { $set: { status: 'done', reviewable: true } });
      const review = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/review`, { token: outsiderToken });
      expect(review.statusCode).toBe(200);
      expect(review.json().grade).toBeNull();
      const gradebook = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}/grades`, { token: professorToken });
      expect(gradebook.statusCode).toBe(200);
      expect(JSON.stringify(gradebook.json())).not.toContain(session._id);
      const recalculate = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/grades/recalculate`, { token: professorToken, payload: {} });
      expect(recalculate.statusCode).toBe(409);
      expect((await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}`, { token: outsiderToken })).statusCode).toBe(403);
    });

    it(`${anonymous ? 'anonymous' : 'named'} outside live activity respects the rotating join code`, async () => {
      const context = await fixture({ anonymous, quiz: false });
      const { professorToken, outsider, outsiderToken, course, session } = context;
      const question = await addQuestion({ ...context, type: 0 });
      await Session.updateOne({ _id: session._id }, { $set: {
        status: 'running', currentQuestion: question._id,
        joinCodeEnabled: true, joinCodeActive: true, currentJoinCode: '123456',
        chatEnabled: true,
      } });
      const code = (await issue(session._id, professorToken)).json().code;
      expect((await redeem(code, outsiderToken)).statusCode).toBe(200);
      const before = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/live`, { token: outsiderToken });
      expect(before.statusCode).toBe(200);
      expect(before.json().session.chatEnabled).toBe(false);
      expect((await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/join`, {
        token: outsiderToken, payload: {},
      })).statusCode).toBe(400);
      const joined = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/join`, {
        token: outsiderToken, payload: { joinCode: '123456' },
      });
      expect(joined.statusCode).toBe(200);
      await Question.updateOne({ _id: question._id }, { $set: { 'sessionOptions.stats': true } });
      const sendSpy = vi.spyOn(app, 'wsSendToUsers');
      const answered = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/respond`, {
        token: outsiderToken, payload: { answer: '0' },
      });
      expect(answered.statusCode).toBe(201);
      expect(sendSpy.mock.calls.some(([ids, event]) => event === 'session:response-added' && ids.includes(String(outsider._id)))).toBe(true);
      const response = await Response.findOne({ questionId: question._id }).lean();
      expect(response.studentUserId === outsider._id).toBe(!anonymous);
      expect(await Grade.countDocuments({ sessionId: session._id })).toBe(0);
      await authenticatedRequest(app, 'DELETE', `/api/v1/sessions/${session._id}/activity-share`, { token: professorToken });
      expect((await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/live`, { token: outsiderToken })).statusCode).toBe(403);
      sendSpy.mockClear();
      await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${session._id}/question-visibility`, {
        token: professorToken, payload: { hidden: true },
      });
      expect(sendSpy.mock.calls.some(([ids, event]) => event === 'session:visibility-changed' && ids.includes(String(outsider._id)))).toBe(false);
    });
  }
});


describe('shared activity safeguards', () => {
  it('requires course opt-in and revokes outside access when the setting is turned off', async () => {
    const { professorToken, outsiderToken, course, session } = await fixture();
    await Course.updateOne({ _id: course._id }, { $set: { allowSharedActivities: false } });
    expect((await issue(session._id, professorToken)).statusCode).toBe(400);
    expect(await ActivityShare.countDocuments({ sessionId: session._id })).toBe(0);
    const courseUrl = `/api/v1/courses/${course._id}`;
    expect((await authenticatedRequest(app, 'PATCH', courseUrl, {
      token: professorToken, payload: { allowSharedActivities: true },
    })).statusCode).toBe(200);
    const code = (await issue(session._id, professorToken)).json().code;
    await Session.updateOne({ _id: session._id }, { $set: { status: 'visible', quizStart: new Date(Date.now() - 60_000), quizEnd: new Date(Date.now() + 600_000) } });
    expect((await redeem(code, outsiderToken)).statusCode).toBe(200);
    expect((await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/quiz`, { token: outsiderToken })).statusCode).toBe(200);
    expect((await authenticatedRequest(app, 'PATCH', courseUrl, {
      token: professorToken, payload: { allowSharedActivities: false },
    })).statusCode).toBe(200);
    expect((await redeem(code, outsiderToken)).statusCode).toBe(404);
    expect((await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/quiz`, { token: outsiderToken })).statusCode).toBe(403);
    expect((await ActivityShare.findOne({ sessionId: session._id }).lean()).enabled).toBe(false);
    expect((await Session.findById(session._id).lean()).activityAccessEnabled).toBe(false);
    expect((await authenticatedRequest(app, 'PATCH', courseUrl, {
      token: professorToken, payload: { allowSharedActivities: true },
    })).statusCode).toBe(200);
    expect((await redeem(code, outsiderToken)).statusCode).toBe(404);
    expect((await issue(session._id, professorToken)).statusCode).toBe(200);
  });

  it('rejects existing extensions when sharing and blocks new extensions even after sharing is disabled', async () => {
    const { professorToken, outsider, course, session } = await fixture();
    const start = new Date(Date.now() + 60_000);
    const end = new Date(Date.now() + 3_600_000);
    await Course.updateOne({ _id: course._id }, { $addToSet: { students: outsider._id } });
    const extensionPayload = { extensions: [{ userId: outsider._id, quizStart: start.toISOString(), quizEnd: end.toISOString() }] };
    const extensionUrl = `/api/v1/sessions/${session._id}/extensions`;
    const first = await authenticatedRequest(app, 'PATCH', extensionUrl, { token: professorToken, payload: extensionPayload });
    expect(first.statusCode).toBe(200);
    expect((await issue(session._id, professorToken)).statusCode).toBe(409);
    expect((await Session.findById(session._id).lean()).activityEverShared).toBe(false);
    expect(await ActivityShare.countDocuments({ sessionId: session._id })).toBe(0);
    expect((await authenticatedRequest(app, 'PATCH', extensionUrl, { token: professorToken, payload: { extensions: [] } })).statusCode).toBe(200);
    expect((await issue(session._id, professorToken)).statusCode).toBe(200);
    expect((await authenticatedRequest(app, 'PATCH', extensionUrl, { token: professorToken, payload: extensionPayload })).statusCode).toBe(409);
    expect((await authenticatedRequest(app, 'DELETE', `/api/v1/sessions/${session._id}/activity-share`, { token: professorToken })).statusCode).toBe(200);
    expect((await authenticatedRequest(app, 'PATCH', extensionUrl, { token: professorToken, payload: extensionPayload })).statusCode).toBe(409);
  });

  it('refuses sharing when the session already has grades', async () => {
    const { professorToken, outsider, course, session } = await fixture();
    await Grade.create({ userId: outsider._id, sessionId: session._id, courseId: course._id });
    expect((await issue(session._id, professorToken)).statusCode).toBe(409);
    expect((await Session.findById(session._id).lean()).activityEverShared).toBe(false);
    expect(await ActivityShare.countDocuments({ sessionId: session._id })).toBe(0);
  });

  it('keeps an existing grant usable after code expiry without admitting new people', async () => {
    const { professorToken, outsiderToken, session } = await fixture();
    const code = (await issue(session._id, professorToken)).json().code;
    expect((await redeem(code, outsiderToken)).statusCode).toBe(200);
    await ActivityShare.updateOne({ sessionId: session._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await redeem(code, outsiderToken)).statusCode).toBe(200);
    const newcomer = await createTestUser({ email: 'share-newcomer@example.com' });
    const newcomerToken = await getAuthToken(app, newcomer);
    expect((await redeem(code, newcomerToken)).statusCode).toBe(404);
  });

  it('releases correlated anonymous rows only after four people answer each question', async () => {
    const { professor, professorToken, outsider, course, session } = await fixture({ anonymous: true });
    const users = [outsider];
    for (let index = 1; index < 4; index += 1) {
      users.push(await createTestUser({ email: `survey-person-${index}@example.com` }));
    }
    const questions = [];
    for (let index = 0; index < 2; index += 1) {
      const question = await Question.create({
        type: 2, creator: professor._id, sessionId: session._id, courseId: course._id,
        content: `<p>Question ${index + 1}</p>`, plainText: `Question ${index + 1}`,
        sessionOptions: { hidden: false, attempts: [{ number: 1 }] },
      });
      questions.push(question);
    }
    await Session.updateOne({ _id: session._id }, { $set: {
      questions: questions.map((question) => question._id), status: 'done', reviewable: true,
    } });
    const code = (await issue(session._id, professorToken)).json().code;
    for (const [index, user] of users.entries()) {
      const token = await getAuthToken(app, user);
      expect((await redeem(code, token)).statusCode).toBe(200);
      const participantId = getSessionParticipantId(session, user._id);
      await Response.create({ questionId: questions[0]._id, studentUserId: participantId, attempt: 1, answer: `first-${index}` });
      if (index < 3) await Response.create({ questionId: questions[1]._id, studentUserId: participantId, attempt: 1, answer: `second-${index}` });
    }
    const resultsUrl = `/api/v1/sessions/${session._id}/results`;
    const withheld = await authenticatedRequest(app, 'GET', resultsUrl, { token: professorToken });
    expect(withheld.statusCode).toBe(200);
    expect(withheld.json().studentResults).toEqual([]);
    expect(withheld.json().anonymousSummary.responsesWithheld).toBe(true);
    await Response.create({
      questionId: questions[1]._id, studentUserId: getSessionParticipantId(session, users[3]._id),
      attempt: 1, answer: 'second-3',
    });
    const released = await authenticatedRequest(app, 'GET', resultsUrl, { token: professorToken });
    expect(released.statusCode).toBe(200);
    expect(released.json().studentResults).toHaveLength(4);
    for (const row of released.json().studentResults) {
      expect(row.studentId).toMatch(/^respondent-[1-4]$/);
      expect(row.questionResults).toHaveLength(2);
      expect(row.questionResults.every((entry) => entry.responses.length === 1)).toBe(true);
    }
    const serialized = JSON.stringify(released.json());
    for (const user of users) expect(serialized).not.toContain(user._id);
    expect(await Grade.countDocuments({ sessionId: session._id })).toBe(0);
  });
});
