import Course from '../models/Course.js';
import Grade from '../models/Grade.js';
import Question from '../models/Question.js';
import Response from '../models/Response.js';
import Session from '../models/Session.js';
import Settings from '../models/Settings.js';
import User from '../models/User.js';
import AiGradingJob from '../models/AiGradingJob.js';
import { normalizeAiBackends, requestAiCompletion } from './ai.js';
import { recomputeGradeAggregates } from './grading.js';

const activeJobs = new Map();
const HALTED_NOTE = 'AI grading was halted by an instructor.';

function findModel(backends, backendId, modelId) {
  const backend = backends.find((entry) => entry.id === backendId);
  const model = backend?.models?.find((entry) => entry.id === modelId && entry.available !== false);
  return backend && model ? { backend, model } : null;
}

function resolveModel(course, settings, requestedBackendId = '', requestedModelId = '') {
  const backendId = requestedBackendId || course.aiDefaultBackendId || course.aiSelectedBackendId || settings.AI_DefaultBackendId;
  const modelId = requestedModelId || course.aiDefaultModelId || course.aiSelectedModelId || settings.AI_DefaultModelId;
  return findModel(normalizeAiBackends(settings.AI_Backends || []), backendId, modelId)
    || findModel(normalizeAiBackends(course.aiBackends || []), backendId, modelId);
}

function plainText(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function studentName(user, grade) {
  const name = `${user?.profile?.firstname || ''} ${user?.profile?.lastname || ''}`.trim();
  return name || user?.emails?.[0]?.address || grade?.name || 'Student';
}

function parseModelJson(source) {
  try {
    return JSON.parse(source);
  } catch (originalError) {
    // Models occasionally emit LaTeX-style backslashes (for example \(x\))
    // without JSON-escaping them. Repair only invalid JSON escape sequences;
    // valid escapes such as \n, \" and \u1234 remain untouched.
    const repaired = source
      .replace(/\\u(?![0-9a-fA-F]{4})/g, '\\\\u')
      .replace(/\\(?!["\\/bfnrtu])/g, '\\\\')
      .replace(/\\$/g, '\\\\');
    if (repaired === source) throw originalError;
    return JSON.parse(repaired);
  }
}

export function parseGrade(content, maxPoints) {
  const source = String(content || '').trim().replace(/^```json\s*|\s*```$/g, '');
  const parsed = parseModelJson(source);
  const points = Number(parsed.points);
  if (!Number.isFinite(points) || points < 0 || points > maxPoints) throw new Error('AI returned an invalid grade');
  const inappropriate = parsed.inappropriate?.flagged && String(parsed.inappropriate?.quote || '').trim()
    ? {
        quote: String(parsed.inappropriate.quote).trim().slice(0, 1_000),
        reason: String(parsed.inappropriate.reason || '').trim().slice(0, 1_000),
      }
    : null;
  return {
    points,
    feedback: String(parsed.feedback || ''),
    justification: String(parsed.justification || '').trim().slice(0, 2_000),
    ...(inappropriate ? { inappropriate } : {}),
  };
}

async function appendHaltedLog(job, haltedAt) {
  const entry = { status: 'halted', note: HALTED_NOTE, timestamp: haltedAt };
  const session = await Session.findById(job.sessionId).select('aiGradingLog').lean();
  const runs = Array.isArray(session?.aiGradingLog?.runs) ? session.aiGradingLog.runs : [];
  const existingRun = runs.find((run) => String(run.jobId) === String(job._id));
  if (existingRun) {
    await Session.updateOne(
      { _id: job.sessionId, 'aiGradingLog.runs.jobId': job._id },
      {
        $push: { 'aiGradingLog.runs.$[run].entries': entry },
        $set: {
          'aiGradingLog.runs.$[run].status': 'halted',
          'aiGradingLog.runs.$[run].haltedAt': haltedAt,
          'aiGradingLog.updatedAt': haltedAt,
        },
      },
      { arrayFilters: [{ 'run.jobId': job._id }] }
    );
    return;
  }

  const haltedRun = {
    jobId: job._id,
    startedAt: job.createdAt || haltedAt,
    haltedAt,
    status: 'halted',
    entries: [entry],
  };
  await Session.updateOne(
    { _id: job.sessionId },
    { $set: { aiGradingLog: { runs: [...runs, haltedRun], updatedAt: haltedAt } } }
  );
}

export async function haltAiGradingJob(jobId) {
  const haltedAt = new Date();
  const job = await AiGradingJob.findOneAndUpdate(
    { _id: jobId, status: { $in: ['queued', 'running'] } },
    { $set: { status: 'halted', error: '', haltedAt } },
    { returnDocument: 'after' }
  );
  if (!job) return null;

  const controller = activeJobs.get(String(job._id));
  if (controller) controller.abort();

  const total = Number(job.total) || 0;
  const completed = Number(job.completed) || 0;
  job.report = {
    ...(job.report?.toObject?.() || job.report || {}),
    summary: total
      ? `AI grading was halted after ${completed} of ${total} grading steps.`
      : 'AI grading was halted before grading progress was available.',
  };
  await job.save();
  await appendHaltedLog(job, haltedAt);
  return job;
}

function latestResponse(responses) {
  return [...responses].sort((a, b) => b.attempt - a.attempt || new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt))
    .find((response) => plainText(response.answerWysiwyg || response.answer));
}

function sessionQuestionLabel(questionNumber) {
  return `Q${questionNumber}`;
}

async function assertJobRunning(jobId, signal) {
  signal.throwIfAborted();
  const running = await AiGradingJob.exists({ _id: jobId, status: 'running' });
  if (running) return;
  const error = new Error('AI grading halted');
  error.name = 'AbortError';
  throw error;
}

export async function runAiGradingJob(jobId) {
  const controller = new AbortController();
  activeJobs.set(String(jobId), controller);
  const job = await AiGradingJob.findOneAndUpdate(
    { _id: jobId, status: 'queued' },
    { $set: { status: 'running' } },
    { returnDocument: 'after' }
  );
  if (!job) {
    if (activeJobs.get(String(jobId)) === controller) activeJobs.delete(String(jobId));
    return;
  }
  let questions = [];
  let summaries = {};
  let appendLog = null;
  try {
    const [course, session, settings] = await Promise.all([
      Course.findById(job.courseId).lean(), Session.findById(job.sessionId).lean(), Settings.findById('settings').lean(),
    ]);
    const selected = resolveModel(course, settings || {}, job.backendId, job.modelId);
    if (!selected) throw new Error('No available AI model is selected for this course');
    const runStartedAt = new Date();
    const existingRuns = Array.isArray(session?.aiGradingLog?.runs)
      ? session.aiGradingLog.runs
      : [];
    await Session.updateOne({ _id: job.sessionId }, { $set: {
      aiGradingLog: {
        runs: [...existingRuns, { jobId: job._id, startedAt: runStartedAt, status: 'running', entries: [] }],
        updatedAt: runStartedAt,
      },
    } });
    appendLog = async (entry) => {
      const loggedEntry = { ...entry, timestamp: new Date() };
      job.log.push(loggedEntry);
      await Session.updateOne(
        { _id: job.sessionId },
        { $push: { 'aiGradingLog.runs.$[run].entries': loggedEntry }, $set: { 'aiGradingLog.updatedAt': new Date() } },
        { arrayFilters: [{ 'run.jobId': job._id }] }
      );
    };
    const selectedQuestionIds = new Set(job.questionIds.map(String));
    const questionsById = new Map(
      (await Question.find({ _id: { $in: job.questionIds } }).lean())
        .map((question) => [String(question._id), question])
    );
    questions = (session.questions || []).flatMap((questionId, sessionIndex) => {
      const question = questionsById.get(String(questionId));
      return selectedQuestionIds.has(String(questionId)) && question
        ? [{ ...question, sessionQuestionNumber: sessionIndex + 1 }]
        : [];
    });
    const grades = await Grade.find({ sessionId: job.sessionId, courseId: job.courseId });
    const users = await User.find({ _id: { $in: grades.map((grade) => grade.userId) } }).lean();
    const usersById = new Map(users.map((user) => [String(user._id), user]));
    job.total = grades.length * questions.length; job.questionTotal = questions.length; job.studentTotal = grades.length; await job.save();
    summaries = {};
    for (const [questionIndex, question] of questions.entries()) {
      await assertJobRunning(job._id, controller.signal);
      job.currentQuestion = questionIndex + 1; job.currentStudent = 0; await job.save();
      const maxPoints = Number(question?.sessionOptions?.points ?? question?.points ?? 0);
      const questionLabel = sessionQuestionLabel(question.sessionQuestionNumber);
      const setup = job.instructions.get(String(question._id)) || {};
      summaries[question._id] = { graded: 0, zeroed: 0, issues: [] };
      const responses = await Response.find({ questionId: question._id }).lean();
      for (const [studentIndex, grade] of grades.entries()) {
        await assertJobRunning(job._id, controller.signal);
        job.currentStudent = studentIndex + 1; await job.save();
        const markIndex = grade.marks.findIndex((mark) => String(mark.questionId) === String(question._id));
        const student = studentName(usersById.get(String(grade.userId)), grade);
        if (markIndex < 0) {
          await appendLog({ question: questionLabel, student, status: 'skipped', note: 'Skipped: no mark exists for this question.' });
          job.completed += 1; await job.save(); continue;
        }
        if (!setup.regrade && !grade.marks[markIndex].needsGrading) {
          await appendLog({ question: questionLabel, student, status: 'skipped', note: 'Skipped: this mark does not need grading.' });
          job.completed += 1; await job.save(); continue;
        }
        const joined = session.quiz ? session.submittedQuiz?.includes(grade.userId) : session.joined?.includes(grade.userId);
        const response = latestResponse(responses.filter((entry) => String(entry.studentUserId) === String(grade.userId)));
        let result = { points: 0, feedback: '', justification: '' };
        if (joined && response) {
          const prompt = [
            `You are grading a student's response to this question: ${plainText(question.content || question.plainText)}.`,
            question.solution ? `Solution: ${plainText(question.solution)}.` : '',
            `Maximum points: ${maxPoints}. Grading instructions: ${setup.grading || ''}`,
            setup.feedback ? `Feedback instructions: ${setup.feedback}` : '',
            `Student response: ${plainText(response.answerWysiwyg || response.answer)}.`,
            'Also assess whether the response contains inappropriate, abusive, threatening, discriminatory, sexually explicit, or otherwise concerning content. Include a short direct quote only when flagging it.',
            'Return only JSON: {"points": number, "feedback": string, "justification": string, "inappropriate": {"flagged": boolean, "quote": string, "reason": string}}. The justification must be a concise, instructor-facing explanation citing the response and grading criteria. Do not reveal private chain-of-thought or hidden reasoning.',
          ].filter(Boolean).join('\n');
          const content = await requestAiCompletion(selected.backend, selected.model.id, [{ role: 'user', content: prompt }], controller.signal);
          await assertJobRunning(job._id, controller.signal);
          result = parseGrade(content, maxPoints);
          await appendLog({ question: questionLabel, student, status: 'graded', points: result.points, outOf: maxPoints, feedback: result.feedback, justification: result.justification, inappropriate: result.inappropriate, prompt, response: content });
          summaries[question._id].graded += 1;
        } else {
          const note = joined
            ? 'Assigned 0: no meaningful response was submitted.'
            : 'Assigned 0: the student did not join or submit this activity.';
          result.justification = note;
          await appendLog({ question: questionLabel, student, status: 'zeroed', points: 0, outOf: maxPoints, note, justification: note });
          summaries[question._id].zeroed += 1;
        }
        await assertJobRunning(job._id, controller.signal);
        grade.marks[markIndex].points = result.points;
        grade.marks[markIndex].feedback = result.feedback;
        grade.marks[markIndex].automatic = false;
        grade.marks[markIndex].aiGraded = true;
        grade.marks[markIndex].needsGrading = false;
        recomputeGradeAggregates(grade);
        await grade.save();
        job.completed += 1; await job.save();
      }
    }
    await assertJobRunning(job._id, controller.signal);
    const completedJob = await AiGradingJob.findOneAndUpdate(
      { _id: job._id, status: 'running' },
      { $set: { status: 'completed', report: { summaries: questions.map((question) => ({ question: sessionQuestionLabel(question.sessionQuestionNumber), ...summaries[question._id] })), summary: `AI grading completed for ${questions.length} question(s).` } } },
      { returnDocument: 'after' }
    );
    if (!completedJob) return;
    await Session.updateOne({ _id: job.sessionId, 'aiGradingLog.runs.jobId': job._id }, { $set: { 'aiGradingLog.runs.$.status': 'completed', 'aiGradingLog.updatedAt': new Date() } });
  } catch (error) {
    const currentJob = await AiGradingJob.findById(job._id).select('status').lean();
    if (currentJob?.status === 'halted') return;
    job.status = 'failed';
    job.error = error.message || 'AI grading failed';
    if (appendLog) {
      try { await appendLog({ status: 'failed', note: `AI grading failed: ${job.error}` }); }
      catch { /* Preserve the job failure even if durable-log storage is unavailable. */ }
    }
    await Session.updateOne({ _id: job.sessionId, 'aiGradingLog.runs.jobId': job._id }, { $set: { 'aiGradingLog.runs.$.status': 'failed', 'aiGradingLog.updatedAt': new Date() } });
    job.report = {
      summaries: questions.map((question) => ({
        question: sessionQuestionLabel(question.sessionQuestionNumber),
        ...(summaries[question._id] || { graded: 0, zeroed: 0, issues: [] }),
      })),
      summary: '',
    };
    await job.save();
  } finally {
    if (activeJobs.get(String(job._id)) === controller) activeJobs.delete(String(job._id));
  }
}
