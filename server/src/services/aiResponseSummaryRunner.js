import Course from '../models/Course.js';
import Session from '../models/Session.js';
import Response from '../models/Response.js';
import Settings from '../models/Settings.js';
import AiResponseSummary from '../models/AiResponseSummary.js';
import { normalizeAiBackends, requestAiCompletion } from './ai.js';

const activeSummaryJobs = new Map();

export function isAiResponseSummaryActive(id) {
  return activeSummaryJobs.has(String(id));
}

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

export function queueAiResponseSummary(id) {
  const jobId = String(id);
  if (activeSummaryJobs.has(jobId)) return;
  const controller = new AbortController();
  activeSummaryJobs.set(jobId, controller);
  setImmediate(() => runAiResponseSummary(jobId, controller));
}

export async function haltAiResponseSummary(id) {
  const jobId = String(id);
  const job = await AiResponseSummary.findOneAndUpdate(
    { _id: jobId, status: { $in: ['queued', 'running'] } },
    { $set: { status: 'halted', phase: 'halted', error: '', updatedAt: new Date() } },
    { returnDocument: 'after' }
  );
  if (!job) return null;
  activeSummaryJobs.get(jobId)?.abort();
  return job;
}

export async function runAiResponseSummary(id, suppliedController = null) {
  const jobId = String(id);
  const controller = suppliedController || new AbortController();
  if (!suppliedController) activeSummaryJobs.set(jobId, controller);
  let job = null;
  try {
    job = await AiResponseSummary.findOneAndUpdate(
      { _id: jobId, status: 'queued' },
      { $set: { status: 'running', phase: 'preparing', error: '', updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!job) return;
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
    job = await AiResponseSummary.findOneAndUpdate(
      { _id: jobId, status: 'running' },
      { $set: { total: latest.length, completed: latest.length, phase: 'generating', updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!job) return;
    const joined = session.joined?.length || 0;
    const prompt = `Create a response summary. The header must state: ${joined} students joined the session; ${latest.length} entered a meaningful response. Follow these instructor instructions: ${job.instruction}. Flag inappropriate content or indications of mental-health distress. Responses:\n${latest.map((response, index) => `${index + 1}. ${text(response.answerWysiwyg || response.answer)}`).join('\n')}`;
    const summary = await requestAiCompletion(
      model.backend,
      model.model.id,
      [{ role: 'user', content: prompt }],
      controller.signal
    );
    await AiResponseSummary.findOneAndUpdate(
      { _id: jobId, status: 'running' },
      { $set: { summary, status: 'completed', phase: 'completed', error: '', updatedAt: new Date() } }
    );
  } catch (error) {
    const halted = controller.signal.aborted || error?.name === 'AbortError';
    await AiResponseSummary.findOneAndUpdate(
      { _id: jobId, status: { $in: ['queued', 'running'] } },
      { $set: {
        status: halted ? 'halted' : 'failed',
        phase: halted ? 'halted' : 'failed',
        error: halted ? '' : error.message || 'Summary failed',
        updatedAt: new Date(),
      } }
    );
  } finally {
    if (activeSummaryJobs.get(jobId) === controller) activeSummaryJobs.delete(jobId);
  }
}
