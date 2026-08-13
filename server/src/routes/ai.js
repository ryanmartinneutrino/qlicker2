import AiConversation from '../models/AiConversation.js';
import Course from '../models/Course.js';
import { getOrCreateSettingsDocument } from '../utils/settingsSingleton.js';
import { isCourseInstructorOrAdmin } from '../utils/courseAccess.js';
import { discoverOllamaModels, normalizeAiBackends, serializeAiBackends } from '../services/ai.js';
import { runAiCourseChat } from '../services/aiChatRunner.js';

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
    createdAt: doc.createdAt || null, updatedAt: doc.updatedAt || null,
    ...(includeMessages ? { messages: doc.messages || [] } : {}),
  };
}

export default async function aiRoutes(app) {
  const { authenticate } = app;

  app.post('/discover-models', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const { url, type = 'ollama', courseId = '' } = request.body || {};
    if (!url) return reply.code(400).send({ error: 'Bad Request', message: 'Backend URL is required' });
    if (!(request.user.roles || []).includes('admin')) {
      const course = await Course.findById(courseId).lean();
      const settings = await getOrCreateSettingsDocument({ lean: true });
      if (!course || !isCourseInstructorOrAdmin(course, request.user) || !coursePolicy(settings, course._id).allowCourseBackend) {
        return reply.code(403).send({ error: 'Forbidden', message: 'This course cannot configure its own AI backend' });
      }
    }
    if (type !== 'ollama') return reply.code(400).send({ error: 'Bad Request', message: 'Model discovery currently supports Ollama backends only' });
    try { return { models: await discoverOllamaModels(url) }; }
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
    conversation.messages.push({ role: 'user', content, contentWysiwyg: String(request.body?.contentWysiwyg || '') });
    try {
      const assistantContent = await runAiCourseChat({
        backend: selected.backend,
        modelId: selected.model.id,
        course,
        user: request.user,
        messages: conversation.messages,
      });
      conversation.messages.push({ role: 'assistant', content: assistantContent });
      conversation.backendId = selected.backend.id; conversation.modelId = selected.model.id;
      conversation.title = conversation.title || content.slice(0, 80); conversation.updatedAt = new Date(); await conversation.save();
      return { conversation: serializeConversation(conversation.toObject(), true) };
    } catch (err) { conversation.messages.pop(); return reply.code(502).send({ error: 'Bad Gateway', message: err.message || 'AI backend request failed' }); }
  });
}
