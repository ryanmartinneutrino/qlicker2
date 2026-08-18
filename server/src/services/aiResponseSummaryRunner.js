import Course from '../models/Course.js';
import Session from '../models/Session.js';
import Response from '../models/Response.js';
import Settings from '../models/Settings.js';
import AiResponseSummary from '../models/AiResponseSummary.js';
import { normalizeAiBackends, requestAiCompletion } from './ai.js';

function selected(course, settings, requestedBackendId = '', requestedModelId = '') {
  const backendId = requestedBackendId
    || course.aiDefaultBackendId
    || course.aiSelectedBackendId
    || settings.AI_DefaultBackendId;
  const modelId = requestedModelId
    || course.aiDefaultModelId
    || course.aiSelectedModelId
    || settings.AI_DefaultModelId;
  return [
    ...normalizeAiBackends(settings.AI_Backends || []),
    ...normalizeAiBackends(course.aiBackends || []),
  ].map((backend) => ({
    backend,
    model: backend.models.find((model) => model.id === modelId && model.available !== false),
  })).find((entry) => entry.backend.id === backendId && entry.model);
}

function text(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

export async function runAiResponseSummary(id) {
  const job = await AiResponseSummary.findById(id);
  if (!job || job.status !== 'queued') return;
  job.status = 'running';
  job.phase = 'preparing';
  await job.save();
  try {
    const [course, session, settings, responses] = await Promise.all([
      Course.findById(job.courseId).lean(),
      Session.findById(job.sessionId).lean(),
      Settings.findById('settings').lean(),
      Response.find({ questionId: job.questionId }).lean(),
    ]);
    const model = selected(course, settings || {}, job.backendId, job.modelId);
    if (!model) throw new Error('No available AI model is selected');
    const latest = Object.values(responses.reduce((all, response) => {
      const existing = all[response.studentUserId];
      return !existing || response.attempt > existing.attempt
        ? { ...all, [response.studentUserId]: response }
        : all;
    }, {})).filter((response) => text(response.answerWysiwyg || response.answer));
    job.total = latest.length;
    job.completed = latest.length;
    job.phase = 'generating';
    await job.save();
    const joined = session.joined?.length || 0;
    const prompt = `Create a response summary. The header must state: ${joined} students joined the session; ${latest.length} entered a meaningful response. Follow these instructor instructions: ${job.instruction}. Flag inappropriate content or indications of mental-health distress. Responses:\n${latest.map((response, index) => `${index + 1}. ${text(response.answerWysiwyg || response.answer)}`).join('\n')}`;
    job.summary = await requestAiCompletion(model.backend, model.model.id, [{ role: 'user', content: prompt }]);
    job.status = 'completed';
    job.phase = 'completed';
    await job.save();
  } catch (error) {
    job.status = 'failed';
    job.phase = 'failed';
    job.error = error.message || 'Summary failed';
    await job.save();
  }
}
