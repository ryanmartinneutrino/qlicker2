import AiConversation from '../models/AiConversation.js';
import AiGradingInstruction from '../models/AiGradingInstruction.js';
import AiGradingJob from '../models/AiGradingJob.js';
import AiSessionRubric from '../models/AiSessionRubric.js';
import AiResponseSummary from '../models/AiResponseSummary.js';
import Course from '../models/Course.js';
import Session from '../models/Session.js';
import { getOrCreateSettingsDocument } from '../utils/settingsSingleton.js';
import { isCourseInstructorOrAdmin } from '../utils/courseAccess.js';
import { discoverOllamaModels, normalizeAiBackends, serializeAiBackends } from '../services/ai.js';
import { queueAiCourseChat, stopAiCourseChat } from '../services/aiChatJobRunner.js';
import { runAiGradingJob } from '../services/aiGradingRunner.js';
import { runAiResponseSummary } from '../services/aiResponseSummaryRunner.js';

const READ_LIMIT = { max: 60, timeWindow: '1 minute' };
const WRITE_LIMIT = { max: 20, timeWindow: '1 minute' };

async function instructorCourse(request, reply) {
  const course = await Course.findById(request.params.courseId).lean();
  if (!course) { reply.code(404).send({ error: 'Not Found', message: 'Course not found' }); return null; }
  if (!isCourseInstructorOrAdmin(course, request.user)) { reply.code(403).send({ error: 'Forbidden', message: 'Only course instructors can use AI helper' }); return null; }
  return course;
}

function coursePolicy(settings, courseId) {
  const id = String(courseId);
  const enabled = !!settings?.AI_Enabled && (settings?.AI_EnabledCourses || []).map(String).includes(id);
  return { enabled, allowCourseBackend: enabled && (settings?.AI_AllowCourseBackendCourses || []).map(String).includes(id) };
}

function findModel(backends, backendId, modelId) {
  const backend = (backends || []).find((entry) => String(entry.id) === String(backendId));
  const model = (backend?.models || []).find((entry) => String(entry.id) === String(modelId) && entry.available !== false);
  return backend && model ? { backend, model } : null;
}

function resolveModel(course, settings, policy) {
  const backendId = course.aiSelectedBackendId || course.aiDefaultBackendId || settings.AI_DefaultBackendId;
  const modelId = course.aiSelectedModelId || course.aiDefaultModelId || settings.AI_DefaultModelId;
  if (policy.allowCourseBackend) {
    const courseMatch = findModel(normalizeAiBackends(course.aiBackends || []), backendId, modelId);
    if (courseMatch) return courseMatch;
  }
  return findModel(normalizeAiBackends(settings.AI_Backends || []), backendId, modelId);
}

function serializeConversation(doc, includeMessages = false) {
  return {
    _id: String(doc._id), title: doc.title || '', backendId: doc.backendId || '', modelId: doc.modelId || '',
    pending: !!doc.pending, pendingError: doc.pendingError || '',
    createdAt: doc.createdAt || null, updatedAt: doc.updatedAt || null,
    ...(includeMessages ? { messages: doc.messages || [] } : {}),
  };
}

export default async function aiRoutes(app) {
  const { authenticate } = app;

  app.post('/discover-models', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const { url, type = 'ollama', courseId = '', apiToken = '' } = request.body || {};
    if (!url) return reply.code(400).send({ error: 'Bad Request', message: 'Backend URL is required' });
    if (!(request.user.roles || []).includes('admin')) {
      const course = await Course.findById(courseId).lean();
      const settings = await getOrCreateSettingsDocument({ lean: true });
      if (!course || !isCourseInstructorOrAdmin(course, request.user) || !coursePolicy(settings, course._id).allowCourseBackend) {
        return reply.code(403).send({ error: 'Forbidden', message: 'This course cannot configure its own AI backend' });
      }
    }
    if (type !== 'ollama') return reply.code(400).send({ error: 'Bad Request', message: 'Model discovery currently supports Ollama backends only' });
    try { return { models: await discoverOllamaModels(url, apiToken) }; }
    catch (err) { return reply.code(400).send({ error: 'Bad Request', message: err.message || 'Could not discover Ollama models' }); }
  });

  app.get('/courses/:courseId/config', { preHandler: authenticate, rateLimit: READ_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const settings = await getOrCreateSettingsDocument({ lean: true });
    const policy = coursePolicy(settings, course._id);
    return {
      ...policy, courseEnabled: !!course.aiEnabled,
      selectedBackendId: course.aiSelectedBackendId || '', selectedModelId: course.aiSelectedModelId || '',
      adminDefaultBackendId: settings.AI_DefaultBackendId || '', adminDefaultModelId: settings.AI_DefaultModelId || '',
      adminBackends: serializeAiBackends(settings.AI_Backends || []).map((backend) => ({ ...backend, models: backend.models.filter((model) => model.available) })),
      courseBackends: policy.allowCourseBackend ? serializeAiBackends(course.aiBackends || []) : [],
      courseDefaultBackendId: course.aiDefaultBackendId || '', courseDefaultModelId: course.aiDefaultModelId || '',
    };
  });

  app.patch('/courses/:courseId/config', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const settings = await getOrCreateSettingsDocument({ lean: true });
    const policy = coursePolicy(settings, course._id);
    if (!policy.enabled) return reply.code(403).send({ error: 'Forbidden', message: 'AI helper is not enabled for this course by the administrator' });
    const body = request.body || {}; const updates = {};
    if (body.enabled !== undefined) updates.aiEnabled = !!body.enabled;
    const hasCustom = body.backends !== undefined || body.defaultBackendId !== undefined || body.defaultModelId !== undefined;
    if (hasCustom && !policy.allowCourseBackend) return reply.code(403).send({ error: 'Forbidden', message: 'This course must use an administrator-configured AI backend' });
    if (body.backends !== undefined) {
      const existingById = new Map(normalizeAiBackends(course.aiBackends || []).map((backend) => [backend.id, backend]));
      updates.aiBackends = normalizeAiBackends(body.backends).map((backend) => ({
        ...backend,
        apiToken: backend.apiToken || existingById.get(backend.id)?.apiToken || '',
      }));
    }
    if (body.defaultBackendId !== undefined) updates.aiDefaultBackendId = body.defaultBackendId;
    if (body.defaultModelId !== undefined) updates.aiDefaultModelId = body.defaultModelId;
    if (body.selectedBackendId !== undefined) updates.aiSelectedBackendId = body.selectedBackendId;
    if (body.selectedModelId !== undefined) updates.aiSelectedModelId = body.selectedModelId;
    const candidate = { ...course, ...updates };
    if (candidate.aiSelectedBackendId || candidate.aiSelectedModelId) {
      if (!resolveModel(candidate, settings, policy)) return reply.code(400).send({ error: 'Bad Request', message: 'Choose an available AI backend and model' });
    }
    await Course.findByIdAndUpdate(course._id, { $set: updates });
    return { success: true };
  });

  app.get('/courses/:courseId/conversations', { preHandler: authenticate, rateLimit: READ_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const conversations = await AiConversation.find({ courseId: course._id, ownerId: request.user.userId }).sort({ updatedAt: -1 }).lean();
    return { conversations: conversations.map((entry) => serializeConversation(entry)) };
  });

  app.post('/courses/:courseId/conversations', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const conversation = await AiConversation.create({ courseId: course._id, ownerId: request.user.userId });
    return reply.code(201).send({ conversation: serializeConversation(conversation.toObject(), true) });
  });

  app.get('/courses/:courseId/conversations/:conversationId', { preHandler: authenticate, rateLimit: READ_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const conversation = await AiConversation.findOne({ _id: request.params.conversationId, courseId: course._id, ownerId: request.user.userId }).lean();
    if (!conversation) return reply.code(404).send({ error: 'Not Found', message: 'AI conversation not found' });
    return { conversation: serializeConversation(conversation, true) };
  });

  app.delete('/courses/:courseId/conversations/:conversationId', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    stopAiCourseChat(request.params.conversationId);
    await AiConversation.deleteOne({ _id: request.params.conversationId, courseId: course._id, ownerId: request.user.userId });
    return reply.code(204).send();
  });

  app.post('/courses/:courseId/conversations/:conversationId/messages', { preHandler: authenticate, rateLimit: { max: 10, timeWindow: '1 minute' } }, async (request, reply) => {
    const content = String(request.body?.content || '').trim();
    if (!content) return reply.code(400).send({ error: 'Bad Request', message: 'A message is required' });
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const settings = await getOrCreateSettingsDocument({ lean: true }); const policy = coursePolicy(settings, course._id);
    if (!policy.enabled || !course.aiEnabled) return reply.code(403).send({ error: 'Forbidden', message: 'AI helper is disabled for this course' });
    const selected = resolveModel(course, settings, policy);
    if (!selected) return reply.code(400).send({ error: 'Bad Request', message: 'Select an available AI backend and model before chatting' });
    const conversation = await AiConversation.findOne({ _id: request.params.conversationId, courseId: course._id, ownerId: request.user.userId });
    if (!conversation) return reply.code(404).send({ error: 'Not Found', message: 'AI conversation not found' });
    if (conversation.pending) return reply.code(409).send({ error: 'Conflict', message: 'An AI response is already in progress for this conversation' });
    conversation.messages.push({ role: 'user', content, contentWysiwyg: String(request.body?.contentWysiwyg || '') });
    const userMessage = conversation.messages.at(-1);
    conversation.pending = true;
    conversation.pendingMessageId = String(userMessage._id);
    conversation.pendingError = '';
    conversation.backendId = selected.backend.id;
    conversation.modelId = selected.model.id;
    conversation.title = conversation.title || content.slice(0, 80);
    conversation.updatedAt = new Date();
    await conversation.save();
    queueAiCourseChat({
      conversationId: conversation._id,
      pendingMessageId: userMessage._id,
      backend: selected.backend,
      modelId: selected.model.id,
      course,
      user: request.user,
    });
    return reply.code(202).send({ conversation: serializeConversation(conversation.toObject(), true) });
  });

  app.post('/courses/:courseId/conversations/:conversationId/stop', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const conversation = await AiConversation.findOneAndUpdate(
      { _id: request.params.conversationId, courseId: course._id, ownerId: request.user.userId, pending: true },
      { $set: { pending: false, pendingMessageId: '', pendingError: 'AI response stopped', updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!conversation) return reply.code(409).send({ error: 'Conflict', message: 'No AI response is in progress for this conversation' });
    stopAiCourseChat(conversation._id);
    return { conversation: serializeConversation(conversation.toObject(), true) };
  });

  app.get('/courses/:courseId/grading-instructions', { preHandler: authenticate }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const instructions = await AiGradingInstruction.find({ courseId: course._id }).sort({ kind: 1, name: 1 }).lean();
    return { instructions: [
      { _id: 'no-feedback', kind: 'feedback', name: 'Do not give feedback', content: 'Leave the feedback blank.' },
      { _id: 'basic-summary', kind: 'summary', name: 'Basic summary', content: 'Summarize the student responses to identify up to five themes in the student responses. Give a few example quoted responses for the students for each theme.' },
      ...instructions,
    ] };
  });

  app.post('/courses/:courseId/grading-instructions', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const { _id, kind, name, content } = request.body || {};
    if (!['grading', 'feedback', 'summary'].includes(kind) || !String(name || '').trim() || !String(content || '').trim()) return reply.code(400).send({ error: 'Bad Request', message: 'Instruction type, name, and content are required' });
    const filter = _id && !['no-feedback', 'basic-summary'].includes(_id) ? { _id, courseId: course._id } : { courseId: course._id, kind, name: String(name).trim() };
    const instruction = await AiGradingInstruction.findOneAndUpdate(filter, { $set: { courseId: course._id, kind, name: String(name).trim(), content: String(content).trim() } }, { upsert: true, new: true, runValidators: true });
    return { instruction };
  });

  app.delete('/courses/:courseId/grading-instructions/:instructionId', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    await AiGradingInstruction.deleteOne({ _id: request.params.instructionId, courseId: course._id });
    return reply.code(204).send();
  });

  app.get('/courses/:courseId/grading-instructions/copy-sources', { preHandler: authenticate }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const courses = await Course.find({
      _id: { $ne: course._id },
      $or: [{ owner: request.user.userId }, { instructors: request.user.userId }],
    }).select('name deptCode courseNumber section semester').sort({ name: 1 }).lean();
    return { courses };
  });

  app.post('/courses/:courseId/grading-instructions/copy', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const sourceCourse = await Course.findById(request.body?.sourceCourseId).lean();
    if (!sourceCourse || !isCourseInstructorOrAdmin(sourceCourse, request.user)) return reply.code(403).send({ error: 'Forbidden', message: 'You cannot copy rubrics from this course' });
    const instructions = await AiGradingInstruction.find({ courseId: sourceCourse._id }).lean();
    if (instructions.length) {
      await AiGradingInstruction.bulkWrite(instructions.map((instruction) => ({
        updateOne: {
          filter: { courseId: course._id, kind: instruction.kind, name: instruction.name },
          update: { $set: { content: instruction.content } },
          upsert: true,
        },
      })));
    }
    return { copied: instructions.length };
  });

  app.get('/courses/:courseId/sessions/:sessionId/ai-grading-rubric', { preHandler: authenticate }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const rubric = await AiSessionRubric.findOne({ courseId: course._id, sessionId: request.params.sessionId }).lean();
    return { rubric };
  });

  app.put('/courses/:courseId/sessions/:sessionId/ai-grading-rubric', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const questionIds = Array.isArray(request.body?.questionIds) ? request.body.questionIds.map(String) : [];
    const instructions = request.body?.instructions && typeof request.body.instructions === 'object' ? request.body.instructions : {};
    const rubric = await AiSessionRubric.findOneAndUpdate(
      { courseId: course._id, sessionId: request.params.sessionId },
      { $set: { questionIds, instructions } },
      { upsert: true, new: true, runValidators: true }
    ).lean();
    return { rubric };
  });

  app.get('/courses/:courseId/sessions/:sessionId/ai-grading', { preHandler: authenticate }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const job = await AiGradingJob.findOne({ courseId: course._id, sessionId: request.params.sessionId }).sort({ createdAt: -1 }).lean();
    const session = await Session.findById(request.params.sessionId).select('aiGradingLog').lean();
    return { job, log: session?.aiGradingLog || null };
  });

  app.delete('/courses/:courseId/sessions/:sessionId/ai-grading-log', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    await Session.updateOne(
      { _id: request.params.sessionId, courseId: course._id },
      { $set: { aiGradingLog: { runs: [], updatedAt: new Date() } } }
    );
    return reply.code(204).send();
  });

  app.post('/courses/:courseId/sessions/:sessionId/ai-grading', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const settings = await getOrCreateSettingsDocument({ lean: true }); const policy = coursePolicy(settings, course._id);
    if (!policy.enabled || !course.aiEnabled || !resolveModel(course, settings, policy)) return reply.code(400).send({ error: 'Bad Request', message: 'Configure an available AI model before grading' });
    const { questionIds, instructions = {}, regrade = false } = request.body || {};
    if (!Array.isArray(questionIds) || questionIds.length === 0) return reply.code(400).send({ error: 'Bad Request', message: 'Select at least one question' });
    const normalizedQuestionIds = questionIds.map(String);
    await AiSessionRubric.findOneAndUpdate(
      { courseId: course._id, sessionId: request.params.sessionId },
      { $set: { questionIds: normalizedQuestionIds, instructions } },
      { upsert: true, new: true, runValidators: true }
    );
    const job = await AiGradingJob.create({ courseId: course._id, sessionId: request.params.sessionId, ownerId: request.user.userId, questionIds: normalizedQuestionIds, instructions, regrade: !!regrade });
    setImmediate(() => runAiGradingJob(job._id));
    return reply.code(202).send({ job });
  });

  app.get('/courses/:courseId/sessions/:sessionId/questions/:questionId/ai-summary', { preHandler: authenticate }, async (request, reply) => { const course = await instructorCourse(request, reply); if (!course) return undefined; return { summary: await AiResponseSummary.findOne({ courseId: course._id, sessionId: request.params.sessionId, questionId: request.params.questionId }).lean() }; });
  app.post('/courses/:courseId/sessions/:sessionId/questions/:questionId/ai-summary', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => { const course = await instructorCourse(request, reply); if (!course) return undefined; const settings = await getOrCreateSettingsDocument({ lean: true }); const policy = coursePolicy(settings, course._id); if (!policy.enabled || !course.aiEnabled || !resolveModel(course, settings, policy)) return reply.code(400).send({ error: 'Bad Request', message: 'Configure an available AI model before summarizing' }); const instruction = String(request.body?.instruction || '').trim(); if (!instruction) return reply.code(400).send({ error: 'Bad Request', message: 'Summary instructions are required' }); const summary = await AiResponseSummary.findOneAndUpdate({ courseId: course._id, sessionId: request.params.sessionId, questionId: request.params.questionId }, { $set: { status: 'queued', phase: 'queued', instruction, completed: 0, total: 0, summary: '', error: '' } }, { upsert: true, new: true }); setImmediate(() => runAiResponseSummary(summary._id)); return reply.code(202).send({ summary }); });
}
