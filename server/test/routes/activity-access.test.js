import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { createApp, createTestUser, getAuthToken, authenticatedRequest } from '../helpers.js';
import ActivityGrant from '../../src/models/ActivityGrant.js';
import ActivityShare from '../../src/models/ActivityShare.js';
import Course from '../../src/models/Course.js';
import Grade from '../../src/models/Grade.js';
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
      section: '001', semester: 'Fall 2026',
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
    expect(status.json()).toEqual({ enabled: true, expiresAt: issued.json().expiresAt });
    expect(code).toMatch(/^S-[A-F0-9]{40}$/);
    const share = await ActivityShare.findOne({ sessionId: session._id }).lean();
    expect(share.codeHash).not.toBe(code);
    expect(JSON.stringify(share)).not.toContain(code);

    const first = await redeem(code.toLowerCase(), outsiderToken);
    const second = await redeem(code, outsiderToken);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json()).toEqual({
      sessionId: session._id, name: session.name, quiz: true, anonymous: false,
    });
    expect(await ActivityGrant.countDocuments({ sessionId: session._id, userId: outsider._id })).toBe(1);
    const grant = await ActivityGrant.findOne({ sessionId: session._id, userId: outsider._id }).lean();
    expect(typeof grant._id).toBe('string');
    expect((await Session.findById(session._id).lean()).participationStarted).toBe(true);
    expect((await Course.findById(course._id).lean()).students).not.toContain(outsider._id);
    expect(await Grade.countDocuments({ sessionId: session._id, userId: outsider._id })).toBe(0);
    // Delivery routes are deliberately not opened by this foundation PR.
    const sessionAccess = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}`, { token: outsiderToken });
    expect(sessionAccess.statusCode).toBe(403);

    const toggle = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${session._id}`, {
      token: professorToken, payload: { anonymous: true },
    });
    expect(toggle.statusCode).toBe(409);
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
    const invalid = await redeem('S-' + '0'.repeat(40), outsiderToken);
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
