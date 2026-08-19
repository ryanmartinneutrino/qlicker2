import AiConversation from '../models/AiConversation.js';
import AiGradingInstruction from '../models/AiGradingInstruction.js';
import AiGradingJob from '../models/AiGradingJob.js';
import AiSessionRubric from '../models/AiSessionRubric.js';
import AiResponseSummary from '../models/AiResponseSummary.js';
import Course from '../models/Course.js';
import Session from '../models/Session.js';
import { getOrCreateSettingsDocument } from '../utils/settingsSingleton.js';
import { isCourseInstructorOrAdmin, resolveCourseAiAudience } from '../utils/courseAccess.js';
import { discoverOllamaModels, discoverOpenAiModels, normalizeAiBackends, serializeAiBackends } from '../services/ai.js';
import { isAiCourseChatActive, queueAiCourseChat, stopAiCourseChat } from '../services/aiChatJobRunner.js';
import {
  courseChatMaxToolRounds,
  defaultStudentChatGuidance,
  MAX_CHAT_TOOL_ROUNDS,
} from '../services/aiChatRunner.js';
import { haltAiGradingJob, runAiGradingJob } from '../services/aiGradingRunner.js';
import {
  haltAiResponseSummary,
  isAiResponseSummaryActive,
  queueAiResponseSummary,
} from '../services/aiResponseSummaryRunner.js';
import { notifyCourseChatUpdated } from './courseChat.js';

const READ_LIMIT = { max: 60, timeWindow: '1 minute' };
const WRITE_LIMIT = { max: 20, timeWindow: '1 minute' };

async function instructorCourse(request, reply) {
  const course = await Course.findById(request.params.courseId).lean();
  if (!course) { reply.code(404).send({ error: 'Not Found', message: 'Course not found' }); return null; }
  if (!isCourseInstructorOrAdmin(course, request.user)) { reply.code(403).send({ error: 'Forbidden', message: 'Only course instructors can use AI helper' }); return null; }
  return course;
}

async function studentCourse(request, reply) {
  const course = await Course.findById(request.params.courseId).lean();
  if (!course) { reply.code(404).send({ error: 'Not Found', message: 'Course not found' }); return null; }
  if (resolveCourseAiAudience(course, request.user) !== 'student') {
    reply.code(403).send({ error: 'Forbidden', message: 'Only students enrolled in this course can use student AI chat' });
    return null;
  }
  if (course.inactive) {
    reply.code(403).send({ error: 'Forbidden', message: 'This course is inactive for students' });
    return null;
  }
  return course;
}

function coursePolicy(settings, courseId) {
  const id = String(courseId);
  const enabled = !!settings?.AI_Enabled && (settings?.AI_EnabledCourses || []).map(String).includes(id);
  return { enabled, allowCourseBackend: enabled && (settings?.AI_AllowCourseBackendCourses || []).map(String).includes(id) };
}

async function studentChatContext(request, reply) {
  const course = await studentCourse(request, reply); if (!course) return null;
  const settings = await getOrCreateSettingsDocument({ lean: true });
  const policy = coursePolicy(settings, course._id);
  if (!policy.enabled || !course.aiEnabled || !course.aiStudentChatEnabled) {
    reply.code(403).send({ error: 'Forbidden', message: 'Student AI chat is disabled for this course' });
    return null;
  }
  return { course, settings, policy };
}

function findModel(backends, backendId, modelId) {
  const backend = (backends || []).find((entry) => String(entry.id) === String(backendId));
  const model = (backend?.models || []).find((entry) => String(entry.id) === String(modelId) && entry.available !== false);
  return backend && model ? { backend, model } : null;
}

function modelKey(backendId, modelId) {
  return `${String(backendId)}::${String(modelId)}`;
}

function availableBackends(course, settings, policy) {
  return [
    ...normalizeAiBackends(settings.AI_Backends || []),
    ...(policy.allowCourseBackend ? normalizeAiBackends(course.aiBackends || []) : []),
  ];
}

function normalizeModelPolicies(value) {
  if (!Array.isArray(value)) return [];
  const unique = new Map();
  value.forEach((entry) => {
    const backendId = String(entry?.backendId || '');
    const modelId = String(entry?.modelId || '');
    if (backendId && modelId) unique.set(modelKey(backendId, modelId), { backendId, modelId, studentAvailable: !!entry?.studentAvailable });
  });
  return [...unique.values()];
}

function effectiveModelPolicies(course, settings, policy) {
  const configured = normalizeModelPolicies(course.aiModelPolicies);
  if (configured.length) return configured;
  const backendId = course.aiDefaultBackendId || course.aiSelectedBackendId || settings.AI_DefaultBackendId || '';
  const modelId = course.aiDefaultModelId || course.aiSelectedModelId || settings.AI_DefaultModelId || '';
  return findModel(availableBackends(course, settings, policy), backendId, modelId)
    ? [{ backendId, modelId, studentAvailable: false }]
    : [];
}

function resolveModel(course, settings, policy, requested = {}) {
  const backendId = requested.backendId || course.aiDefaultBackendId || course.aiSelectedBackendId || settings.AI_DefaultBackendId;
  const modelId = requested.modelId || course.aiDefaultModelId || course.aiSelectedModelId || settings.AI_DefaultModelId;
  const approved = new Set(effectiveModelPolicies(course, settings, policy).map((entry) => modelKey(entry.backendId, entry.modelId)));
  if (!approved.has(modelKey(backendId, modelId))) return null;
  return findModel(availableBackends(course, settings, policy), backendId, modelId);
}

function resolveStudentModel(course, settings, policy, requested = {}) {
  const eligibleModels = approvedModels(course, settings, policy).filter((model) => model.studentAvailable);
  const configured = eligibleModels.find((model) => (
    model.backendId === course.aiStudentDefaultBackendId && model.modelId === course.aiStudentDefaultModelId
  ));
  const fallback = configured || eligibleModels[0] || null;
  const backendId = requested.backendId || fallback?.backendId || '';
  const modelId = requested.modelId || fallback?.modelId || '';
  if (!eligibleModels.some((model) => model.backendId === backendId && model.modelId === modelId)) return null;
  return findModel(availableBackends(course, settings, policy), backendId, modelId);
}

function approvedModels(course, settings, policy) {
  const policies = effectiveModelPolicies(course, settings, policy);
  const policyByKey = new Map(policies.map((entry) => [modelKey(entry.backendId, entry.modelId), entry]));
  return availableBackends(course, settings, policy).flatMap((backend) => backend.models.flatMap((model) => {
    const modelPolicy = policyByKey.get(modelKey(backend.id, model.id));
    return modelPolicy ? [{
      backendId: backend.id,
      backendName: backend.name || backend.url,
      modelId: model.id,
      modelName: model.name,
      studentAvailable: modelPolicy.studentAvailable,
    }] : [];
  }));
}

function conversationAudienceFilter(audience) {
  return audience === 'student' ? { audience: 'student' } : { audience: { $ne: 'student' } };
}

function serializeConversation(doc, includeMessages = false) {
  return {
    _id: String(doc._id), title: doc.title || '', backendId: doc.backendId || '', modelId: doc.modelId || '',
    pending: !!doc.pending, pendingError: doc.pendingError || '',
    createdAt: doc.createdAt || null, updatedAt: doc.updatedAt || null,
    ...(includeMessages ? { messages: doc.messages || [] } : {}),
  };
}

async function recoverOrphanedConversation(conversation) {
  if (!conversation?.pending || isAiCourseChatActive(conversation._id)) return conversation;
  return AiConversation.findOneAndUpdate(
    { _id: conversation._id, pending: true },
    { $set: {
      pending: false,
      pendingMessageId: '',
      pendingError: 'The previous AI request did not complete. You can send another message.',
      updatedAt: new Date(),
    } },
    { returnDocument: 'after' }
  ).lean();
}

async function recoverOrphanedResponseSummary(summary) {
  if (!summary || !['queued', 'running'].includes(summary.status) || isAiResponseSummaryActive(summary._id)) return summary;
  return AiResponseSummary.findOneAndUpdate(
    { _id: summary._id, status: { $in: ['queued', 'running'] } },
    { $set: {
      status: 'failed',
      phase: 'failed',
      error: 'The previous AI summary process did not complete. You can generate it again.',
      updatedAt: new Date(),
    } },
    { returnDocument: 'after' }
  ).lean();
}

export default async function aiRoutes(app) {
  const { authenticate } = app;

  app.post('/discover-models', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const { backendId = '', url, type = 'ollama', courseId = '', apiToken = '' } = request.body || {};
    if (!url) return reply.code(400).send({ error: 'Bad Request', message: 'Backend URL is required' });
    const settings = await getOrCreateSettingsDocument({ lean: true });
    let storedBackend = normalizeAiBackends(settings.AI_Backends || []).find((backend) => backend.id === backendId);
    if (!(request.user.roles || []).includes('admin')) {
      const course = await Course.findById(courseId).lean();
      const policy = course ? coursePolicy(settings, course._id) : { enabled: false, allowCourseBackend: false };
      if (!course || !isCourseInstructorOrAdmin(course, request.user) || !policy.enabled) {
        return reply.code(403).send({ error: 'Forbidden', message: 'This course cannot access AI backends' });
      }
      const courseBackend = normalizeAiBackends(course.aiBackends || []).find((backend) => backend.id === backendId);
      if (courseBackend && policy.allowCourseBackend) storedBackend = courseBackend;
      else if (!storedBackend && !policy.allowCourseBackend) return reply.code(403).send({ error: 'Forbidden', message: 'This course cannot configure its own AI backend' });
    }
    const storedUrl = String(storedBackend?.url || '').replace(/\/+$/, '');
    const requestedUrl = String(url || '').replace(/\/+$/, '');
    const storedToken = storedUrl === requestedUrl ? storedBackend?.apiToken || '' : '';
    const resolvedToken = apiToken || storedToken;
    try {
      const models = type === 'openai'
        ? await discoverOpenAiModels(url, resolvedToken)
        : await discoverOllamaModels(url, resolvedToken);
      return { models };
    } catch (err) {
      return reply.code(400).send({ error: 'Bad Request', message: err.message || 'Could not discover AI models' });
    }
  });

  app.get('/courses/:courseId/config', { preHandler: authenticate, rateLimit: READ_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const settings = await getOrCreateSettingsDocument({ lean: true });
    const policy = coursePolicy(settings, course._id);
    const modelPolicies = effectiveModelPolicies(course, settings, policy);
    const defaultBackendId = course.aiDefaultBackendId || course.aiSelectedBackendId || settings.AI_DefaultBackendId || '';
    const defaultModelId = course.aiDefaultModelId || course.aiSelectedModelId || settings.AI_DefaultModelId || '';
    const availableModels = approvedModels(course, settings, policy);
    const studentModels = availableModels.filter((model) => model.studentAvailable);
    const configuredStudentModel = studentModels.find((model) => (
      model.backendId === course.aiStudentDefaultBackendId && model.modelId === course.aiStudentDefaultModelId
    ));
    const studentDefaultModel = configuredStudentModel || studentModels[0] || null;
    return {
      ...policy, courseEnabled: !!course.aiEnabled,
      selectedBackendId: course.aiSelectedBackendId || '', selectedModelId: course.aiSelectedModelId || '',
      adminDefaultBackendId: settings.AI_DefaultBackendId || '', adminDefaultModelId: settings.AI_DefaultModelId || '',
      adminBackends: serializeAiBackends(settings.AI_Backends || []).map((backend) => ({ ...backend, models: backend.models.filter((model) => model.available) })),
      courseBackends: policy.allowCourseBackend ? serializeAiBackends(course.aiBackends || []) : [],
      courseDefaultBackendId: course.aiDefaultBackendId || '', courseDefaultModelId: course.aiDefaultModelId || '',
      defaultBackendId,
      defaultModelId,
      modelPolicies,
      approvedModels: availableModels,
      instructorChatMaxToolRounds: courseChatMaxToolRounds(course, 'instructor'),
      studentChatEnabled: !!course.aiStudentChatEnabled,
      studentChatGuidance: course.aiStudentChatGuidance || defaultStudentChatGuidance(course.name),
      studentDefaultBackendId: studentDefaultModel?.backendId || '',
      studentDefaultModelId: studentDefaultModel?.modelId || '',
      studentChatMaxToolRounds: courseChatMaxToolRounds(course, 'student'),
    };
  });

  app.get('/student/courses/:courseId/config', { preHandler: authenticate, rateLimit: READ_LIMIT }, async (request, reply) => {
    const context = await studentChatContext(request, reply); if (!context) return undefined;
    const { course, settings, policy } = context;
    const models = approvedModels(course, settings, policy).filter((model) => model.studentAvailable);
    const configured = models.find((model) => (
      model.backendId === course.aiStudentDefaultBackendId && model.modelId === course.aiStudentDefaultModelId
    ));
    const defaultModel = configured || models[0] || null;
    return {
      enabled: true,
      approvedModels: models.map(({ studentAvailable, ...model }) => model),
      defaultBackendId: defaultModel?.backendId || '',
      defaultModelId: defaultModel?.modelId || '',
    };
  });

  app.patch('/courses/:courseId/config', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const settings = await getOrCreateSettingsDocument({ lean: true });
    const policy = coursePolicy(settings, course._id);
    if (!policy.enabled) return reply.code(403).send({ error: 'Forbidden', message: 'AI helper is not enabled for this course by the administrator' });
    const body = request.body || {}; const updates = {};
    if (body.enabled !== undefined) updates.aiEnabled = !!body.enabled;
    const hasCustom = body.backends !== undefined;
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
    if (body.modelPolicies !== undefined) {
      const available = availableBackends({ ...course, ...updates }, settings, policy);
      updates.aiModelPolicies = normalizeModelPolicies(body.modelPolicies).filter((entry) => (
        !!findModel(available, entry.backendId, entry.modelId)
      ));
    }
    if (body.selectedBackendId !== undefined) updates.aiSelectedBackendId = body.selectedBackendId;
    if (body.selectedModelId !== undefined) updates.aiSelectedModelId = body.selectedModelId;
    if (body.instructorChatMaxToolRounds !== undefined) {
      const value = Number(body.instructorChatMaxToolRounds);
      if (!Number.isInteger(value) || value < 1 || value > MAX_CHAT_TOOL_ROUNDS) {
        return reply.code(400).send({ error: 'Bad Request', message: `Professor AI chat internal turns must be a whole number from 1 to ${MAX_CHAT_TOOL_ROUNDS}` });
      }
      updates.aiInstructorChatMaxToolRounds = value;
    }
    if (body.studentChatEnabled !== undefined) updates.aiStudentChatEnabled = !!body.studentChatEnabled;
    if (body.studentChatGuidance !== undefined) updates.aiStudentChatGuidance = String(body.studentChatGuidance || '').trim();
    if (body.studentDefaultBackendId !== undefined) updates.aiStudentDefaultBackendId = String(body.studentDefaultBackendId || '');
    if (body.studentDefaultModelId !== undefined) updates.aiStudentDefaultModelId = String(body.studentDefaultModelId || '');
    if (body.studentChatMaxToolRounds !== undefined) {
      const value = Number(body.studentChatMaxToolRounds);
      if (!Number.isInteger(value) || value < 1 || value > MAX_CHAT_TOOL_ROUNDS) {
        return reply.code(400).send({ error: 'Bad Request', message: `Student AI chat internal turns must be a whole number from 1 to ${MAX_CHAT_TOOL_ROUNDS}` });
      }
      updates.aiStudentChatMaxToolRounds = value;
    }
    const candidate = { ...course, ...updates };
    if (candidate.aiDefaultBackendId || candidate.aiDefaultModelId || candidate.aiSelectedBackendId || candidate.aiSelectedModelId) {
      if (!resolveModel(candidate, settings, policy)) return reply.code(400).send({ error: 'Bad Request', message: 'Choose an approved AI backend and model' });
    }
    if (candidate.aiStudentDefaultBackendId || candidate.aiStudentDefaultModelId) {
      const studentModels = approvedModels(candidate, settings, policy).filter((model) => model.studentAvailable);
      const studentModel = studentModels.find((model) => (
        model.backendId === candidate.aiStudentDefaultBackendId
        && model.modelId === candidate.aiStudentDefaultModelId
      ));
      if (!studentModel) {
        const explicitlySelectedStudentModel = body.studentDefaultBackendId !== undefined || body.studentDefaultModelId !== undefined;
        if (explicitlySelectedStudentModel) return reply.code(400).send({ error: 'Bad Request', message: 'Choose a model that is available to students' });
        updates.aiStudentDefaultBackendId = studentModels[0]?.backendId || '';
        updates.aiStudentDefaultModelId = studentModels[0]?.modelId || '';
      }
    }
    const updatedCourse = await Course.findByIdAndUpdate(
      course._id,
      { $set: updates },
      { returnDocument: 'after' }
    ).lean();
    return {
      success: true,
      courseBackends: policy.allowCourseBackend ? serializeAiBackends(updatedCourse.aiBackends || []) : [],
    };
  });

  app.get('/courses/:courseId/conversations', { preHandler: authenticate, rateLimit: READ_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const conversations = await AiConversation.find({ courseId: course._id, ownerId: request.user.userId, ...conversationAudienceFilter('instructor') }).sort({ updatedAt: -1 }).lean();
    return { conversations: conversations.map((entry) => serializeConversation(entry)) };
  });

  app.post('/courses/:courseId/conversations', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const conversation = await AiConversation.create({ courseId: course._id, ownerId: request.user.userId, audience: 'instructor' });
    return reply.code(201).send({ conversation: serializeConversation(conversation.toObject(), true) });
  });

  app.get('/courses/:courseId/conversations/:conversationId', { preHandler: authenticate, rateLimit: READ_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    let conversation = await AiConversation.findOne({ _id: request.params.conversationId, courseId: course._id, ownerId: request.user.userId, ...conversationAudienceFilter('instructor') }).lean();
    if (!conversation) return reply.code(404).send({ error: 'Not Found', message: 'AI conversation not found' });
    conversation = await recoverOrphanedConversation(conversation);
    return { conversation: serializeConversation(conversation, true) };
  });

  app.delete('/courses/:courseId/conversations/:conversationId/pending-error', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    let conversation = await AiConversation.findOne({ _id: request.params.conversationId, courseId: course._id, ownerId: request.user.userId, ...conversationAudienceFilter('instructor') }).lean();
    if (!conversation) return reply.code(404).send({ error: 'Not Found', message: 'AI conversation not found' });
    conversation = await recoverOrphanedConversation(conversation);
    if (!conversation.pending && conversation.pendingError) {
      const cleared = await AiConversation.findOneAndUpdate(
        { _id: conversation._id, pending: false },
        { $set: { pendingError: '' } },
        { returnDocument: 'after' }
      ).lean();
      conversation = cleared || await AiConversation.findById(conversation._id).lean();
    }
    return { conversation: serializeConversation(conversation, true) };
  });

  app.delete('/courses/:courseId/conversations/:conversationId', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const conversation = await AiConversation.findOneAndDelete({
      _id: request.params.conversationId,
      courseId: course._id,
      ownerId: request.user.userId,
      ...conversationAudienceFilter('instructor'),
    });
    if (conversation) stopAiCourseChat(conversation._id);
    return reply.code(204).send();
  });

  app.post('/courses/:courseId/conversations/:conversationId/messages', { preHandler: authenticate, rateLimit: { max: 10, timeWindow: '1 minute' } }, async (request, reply) => {
    const content = String(request.body?.content || '').trim();
    if (!content) return reply.code(400).send({ error: 'Bad Request', message: 'A message is required' });
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const settings = await getOrCreateSettingsDocument({ lean: true }); const policy = coursePolicy(settings, course._id);
    if (!policy.enabled || !course.aiEnabled) return reply.code(403).send({ error: 'Forbidden', message: 'AI helper is disabled for this course' });
    const selected = resolveModel(course, settings, policy, request.body || {});
    if (!selected) return reply.code(400).send({ error: 'Bad Request', message: 'Select an approved AI backend and model before chatting' });
    const conversation = await AiConversation.findOne({ _id: request.params.conversationId, courseId: course._id, ownerId: request.user.userId, ...conversationAudienceFilter('instructor') });
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
      onCourseChatUpdated: (payload) => notifyCourseChatUpdated(app, course, payload),
    });
    return reply.code(202).send({ conversation: serializeConversation(conversation.toObject(), true) });
  });

  app.post('/courses/:courseId/conversations/:conversationId/stop', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const conversation = await AiConversation.findOneAndUpdate(
      { _id: request.params.conversationId, courseId: course._id, ownerId: request.user.userId, pending: true, ...conversationAudienceFilter('instructor') },
      { $set: { pending: false, pendingMessageId: '', pendingError: 'AI response stopped', updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!conversation) return reply.code(409).send({ error: 'Conflict', message: 'No AI response is in progress for this conversation' });
    stopAiCourseChat(conversation._id);
    return { conversation: serializeConversation(conversation.toObject(), true) };
  });

  app.get('/student/courses/:courseId/conversations', { preHandler: authenticate, rateLimit: READ_LIMIT }, async (request, reply) => {
    const context = await studentChatContext(request, reply); if (!context) return undefined;
    const conversations = await AiConversation.find({
      courseId: context.course._id,
      ownerId: request.user.userId,
      ...conversationAudienceFilter('student'),
    }).sort({ updatedAt: -1 }).lean();
    return { conversations: conversations.map((entry) => serializeConversation(entry)) };
  });

  app.post('/student/courses/:courseId/conversations', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const context = await studentChatContext(request, reply); if (!context) return undefined;
    const conversation = await AiConversation.create({
      courseId: context.course._id,
      ownerId: request.user.userId,
      audience: 'student',
    });
    return reply.code(201).send({ conversation: serializeConversation(conversation.toObject(), true) });
  });

  app.get('/student/courses/:courseId/conversations/:conversationId', { preHandler: authenticate, rateLimit: READ_LIMIT }, async (request, reply) => {
    const context = await studentChatContext(request, reply); if (!context) return undefined;
    let conversation = await AiConversation.findOne({
      _id: request.params.conversationId,
      courseId: context.course._id,
      ownerId: request.user.userId,
      ...conversationAudienceFilter('student'),
    }).lean();
    if (!conversation) return reply.code(404).send({ error: 'Not Found', message: 'AI conversation not found' });
    conversation = await recoverOrphanedConversation(conversation);
    return { conversation: serializeConversation(conversation, true) };
  });

  app.delete('/student/courses/:courseId/conversations/:conversationId/pending-error', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const context = await studentChatContext(request, reply); if (!context) return undefined;
    let conversation = await AiConversation.findOne({
      _id: request.params.conversationId,
      courseId: context.course._id,
      ownerId: request.user.userId,
      ...conversationAudienceFilter('student'),
    }).lean();
    if (!conversation) return reply.code(404).send({ error: 'Not Found', message: 'AI conversation not found' });
    conversation = await recoverOrphanedConversation(conversation);
    if (!conversation.pending && conversation.pendingError) {
      const cleared = await AiConversation.findOneAndUpdate(
        { _id: conversation._id, pending: false, ...conversationAudienceFilter('student') },
        { $set: { pendingError: '' } },
        { returnDocument: 'after' }
      ).lean();
      conversation = cleared || await AiConversation.findById(conversation._id).lean();
    }
    return { conversation: serializeConversation(conversation, true) };
  });

  app.delete('/student/courses/:courseId/conversations/:conversationId', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const context = await studentChatContext(request, reply); if (!context) return undefined;
    const conversation = await AiConversation.findOneAndDelete({
      _id: request.params.conversationId,
      courseId: context.course._id,
      ownerId: request.user.userId,
      ...conversationAudienceFilter('student'),
    });
    if (conversation) stopAiCourseChat(conversation._id);
    return reply.code(204).send();
  });

  app.post('/student/courses/:courseId/conversations/:conversationId/messages', { preHandler: authenticate, rateLimit: { max: 10, timeWindow: '1 minute' } }, async (request, reply) => {
    const content = String(request.body?.content || '').trim();
    if (!content) return reply.code(400).send({ error: 'Bad Request', message: 'A message is required' });
    const context = await studentChatContext(request, reply); if (!context) return undefined;
    const { course, settings, policy } = context;
    const selected = resolveStudentModel(course, settings, policy, request.body || {});
    if (!selected) return reply.code(400).send({ error: 'Bad Request', message: 'Select an AI model made available to students before chatting' });
    const conversation = await AiConversation.findOne({
      _id: request.params.conversationId,
      courseId: course._id,
      ownerId: request.user.userId,
      ...conversationAudienceFilter('student'),
    });
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

  app.post('/student/courses/:courseId/conversations/:conversationId/stop', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const context = await studentChatContext(request, reply); if (!context) return undefined;
    const conversation = await AiConversation.findOneAndUpdate(
      {
        _id: request.params.conversationId,
        courseId: context.course._id,
        ownerId: request.user.userId,
        pending: true,
        ...conversationAudienceFilter('student'),
      },
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
    const selectedModel = resolveModel(course, settings, policy, request.body || {});
    if (!policy.enabled || !course.aiEnabled || !selectedModel) return reply.code(400).send({ error: 'Bad Request', message: 'Choose an approved AI model before grading' });
    const { questionIds, instructions = {}, regrade = false } = request.body || {};
    if (!Array.isArray(questionIds) || questionIds.length === 0) return reply.code(400).send({ error: 'Bad Request', message: 'Select at least one question' });
    const normalizedQuestionIds = questionIds.map(String);
    await AiSessionRubric.findOneAndUpdate(
      { courseId: course._id, sessionId: request.params.sessionId },
      { $set: { questionIds: normalizedQuestionIds, instructions } },
      { upsert: true, new: true, runValidators: true }
    );
    const job = await AiGradingJob.create({ courseId: course._id, sessionId: request.params.sessionId, ownerId: request.user.userId, backendId: selectedModel.backend.id, modelId: selectedModel.model.id, questionIds: normalizedQuestionIds, instructions, regrade: !!regrade });
    setImmediate(() => runAiGradingJob(job._id));
    return reply.code(202).send({ job });
  });

  app.post('/courses/:courseId/sessions/:sessionId/ai-grading/halt', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const activeJob = await AiGradingJob.findOne({
      courseId: course._id,
      sessionId: request.params.sessionId,
      status: { $in: ['queued', 'running'] },
    }).sort({ createdAt: -1 });
    if (!activeJob) return reply.code(409).send({ error: 'Conflict', message: 'No AI grading job is in progress' });
    const job = await haltAiGradingJob(activeJob._id);
    if (!job) return reply.code(409).send({ error: 'Conflict', message: 'The AI grading job has already finished' });
    const session = await Session.findById(request.params.sessionId).select('aiGradingLog').lean();
    return { job, log: session?.aiGradingLog || null };
  });

  app.get('/courses/:courseId/sessions/:sessionId/questions/:questionId/ai-summary', { preHandler: authenticate }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    let summary = await AiResponseSummary.findOne({ courseId: course._id, sessionId: request.params.sessionId, questionId: request.params.questionId }).lean();
    summary = await recoverOrphanedResponseSummary(summary);
    return { summary };
  });

  app.post('/courses/:courseId/sessions/:sessionId/questions/:questionId/ai-summary', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const settings = await getOrCreateSettingsDocument({ lean: true });
    const policy = coursePolicy(settings, course._id);
    const selectedModel = resolveModel(course, settings, policy, request.body || {});
    if (!policy.enabled || !course.aiEnabled || !selectedModel) return reply.code(400).send({ error: 'Bad Request', message: 'Choose an approved AI model before summarizing' });
    const instruction = String(request.body?.instruction || '').trim();
    if (!instruction) return reply.code(400).send({ error: 'Bad Request', message: 'Summary instructions are required' });
    const summary = await AiResponseSummary.findOneAndUpdate(
      { courseId: course._id, sessionId: request.params.sessionId, questionId: request.params.questionId },
      { $set: {
        status: 'queued',
        phase: 'queued',
        instruction,
        backendId: selectedModel.backend.id,
        modelId: selectedModel.model.id,
        completed: 0,
        total: 0,
        summary: '',
        error: '',
      } },
      { upsert: true, new: true }
    );
    queueAiResponseSummary(summary._id);
    return reply.code(202).send({ summary });
  });

  app.post('/courses/:courseId/sessions/:sessionId/questions/:questionId/ai-summary/halt', { preHandler: authenticate, rateLimit: WRITE_LIMIT }, async (request, reply) => {
    const course = await instructorCourse(request, reply); if (!course) return undefined;
    const summary = await AiResponseSummary.findOne({
      courseId: course._id,
      sessionId: request.params.sessionId,
      questionId: request.params.questionId,
      status: { $in: ['queued', 'running'] },
    }).select('_id').lean();
    if (!summary) return reply.code(409).send({ error: 'Conflict', message: 'No AI response summary is in progress' });
    const halted = await haltAiResponseSummary(summary._id);
    if (!halted) return reply.code(409).send({ error: 'Conflict', message: 'The AI response summary has already finished' });
    return { summary: halted };
  });
}
