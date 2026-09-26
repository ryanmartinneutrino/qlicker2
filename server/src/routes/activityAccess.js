import ActivityShare from '../models/ActivityShare.js';
import Course from '../models/Course.js';
import Session from '../models/Session.js';
import { issueActivityCode, redeemActivityCode } from '../services/activityAccess.js';
import { isCourseInstructorOrAdmin } from '../utils/courseAccess.js';

const sessionParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1 } },
};
const codeStatus = {
  type: 'object',
  required: ['enabled'],
  properties: {
    enabled: { type: 'boolean' },
    expiresAt: { type: ['string', 'null'], format: 'date-time' },
  },
};

async function loadInstructorSession(request, reply) {
  const session = await Session.findById(request.params.id).lean();
  if (!session) {
    reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
    return null;
  }
  const course = await Course.findById(session.courseId).lean();
  if (!course || !isCourseInstructorOrAdmin(course, request.user)) {
    reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
    return null;
  }
  return { session, course };
}

export default async function activityAccessRoutes(app) {
  app.get('/sessions/:id/activity-share', {
    preHandler: app.authenticate,
    schema: { params: sessionParams, response: { 200: codeStatus } },
  }, async (request, reply) => {
    if (!await loadInstructorSession(request, reply)) return;
    const share = await ActivityShare.findOne({ sessionId: request.params.id })
      .select('enabled expiresAt').lean();
    return { enabled: !!share?.enabled, expiresAt: share?.expiresAt || null };
  });

  app.post('/sessions/:id/activity-share', {
    preHandler: app.authenticate,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      params: sessionParams,
      body: {
        type: 'object',
        properties: { expiresAt: { type: 'string', format: 'date-time' } },
        additionalProperties: false,
      },
      response: {
        200: {
          type: 'object',
          required: ['code', 'expiresAt'],
          properties: {
            code: { type: 'string' },
            expiresAt: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const context = await loadInstructorSession(request, reply);
    if (!context) return;
    if (context.session.practiceQuiz || context.session.studentCreated || context.course.inactive) {
      return reply.code(400).send({ error: 'Bad Request', message: 'This session cannot be shared by activity code' });
    }
    const now = Date.now();
    const expiresAt = request.body?.expiresAt
      ? new Date(request.body.expiresAt)
      : new Date(now + 30 * 24 * 60 * 60 * 1000);
    if (expiresAt.getTime() <= now || expiresAt.getTime() > now + 365 * 24 * 60 * 60 * 1000) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Expiry must be within the next year' });
    }
    const issued = await issueActivityCode(context.session._id, expiresAt);
    // The plaintext code is returned once; only its hash is persisted.
    return { code: issued.code, expiresAt: issued.share.expiresAt.toISOString() };
  });

  app.delete('/sessions/:id/activity-share', {
    preHandler: app.authenticate,
    schema: { params: sessionParams, response: { 200: codeStatus } },
  }, async (request, reply) => {
    if (!await loadInstructorSession(request, reply)) return;
    await ActivityShare.updateOne(
      { sessionId: request.params.id },
      { $set: { enabled: false, updatedAt: new Date() }, $inc: { accessEpoch: 1 } }
    );
    return { enabled: false, expiresAt: null };
  });

  app.post('/activity-codes/redeem', {
    preHandler: app.authenticate,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['code'],
        properties: { code: { type: 'string', minLength: 1, maxLength: 80 } },
        additionalProperties: false,
      },
      response: {
        200: {
          type: 'object',
          required: ['sessionId', 'name', 'quiz', 'anonymous'],
          properties: {
            sessionId: { type: 'string' },
            name: { type: 'string' },
            quiz: { type: 'boolean' },
            anonymous: { type: 'boolean' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const activity = await redeemActivityCode(request.body.code, request.user.userId);
    if (!activity) {
      return reply.code(404).send({ error: 'Not Found', message: 'Invalid or unavailable activity code' });
    }
    return activity;
  });
}
