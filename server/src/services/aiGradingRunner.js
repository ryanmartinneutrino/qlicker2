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

function findModel(backends, backendId, modelId) {
  const backend = backends.find((entry) => entry.id === backendId);
  const model = backend?.models?.find((entry) => entry.id === modelId && entry.available !== false);
  return backend && model ? { backend, model } : null;
}

function resolveModel(course, settings) {
  const backendId = course.aiSelectedBackendId || course.aiDefaultBackendId || settings.AI_DefaultBackendId;
  const modelId = course.aiSelectedModelId || course.aiDefaultModelId || settings.AI_DefaultModelId;
  return findModel(normalizeAiBackends(course.aiBackends || []), backendId, modelId)
    || findModel(normalizeAiBackends(settings.AI_Backends || []), backendId, modelId);
}

function plainText(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function studentName(user, grade) {
  const name = `${user?.profile?.firstname || ''} ${user?.profile?.lastname || ''}`.trim();
  return name || user?.emails?.[0]?.address || grade?.name || 'Student';
}

function parseGrade(content, maxPoints) {
  const source = String(content || '').trim().replace(/^```json\s*|\s*```$/g, '');
  const parsed = JSON.parse(source);
  const points = Number(parsed.points);
  if (!Number.isFinite(points) || points < 0 || points > maxPoints) throw new Error('AI returned an invalid grade');
  return {
    points,
    feedback: String(parsed.feedback || ''),
    justification: String(parsed.justification || '').trim().slice(0, 2_000),
  };
}

function latestResponse(responses) {
  return [...responses].sort((a, b) => b.attempt - a.attempt || new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt))
    .find((response) => plainText(response.answerWysiwyg || response.answer));
}

export async function runAiGradingJob(jobId) {
  const job = await AiGradingJob.findById(jobId);
  if (!job || job.status !== 'queued') return;
  job.status = 'running'; await job.save();
  try {
    const [course, session, settings] = await Promise.all([
      Course.findById(job.courseId).lean(), Session.findById(job.sessionId).lean(), Settings.findById('settings').lean(),
    ]);
    const selected = resolveModel(course, settings || {});
    if (!selected) throw new Error('No available AI model is selected for this course');
    const questions = await Question.find({ _id: { $in: job.questionIds } }).lean();
    const grades = await Grade.find({ sessionId: job.sessionId, courseId: job.courseId });
    const users = await User.find({ _id: { $in: grades.map((grade) => grade.userId) } }).lean();
    const usersById = new Map(users.map((user) => [String(user._id), user]));
    job.total = grades.length * questions.length; job.questionTotal = questions.length; job.studentTotal = grades.length; await job.save();
    const summaries = {};
    for (const [questionIndex, question] of questions.entries()) {
      job.currentQuestion = questionIndex + 1; job.currentStudent = 0; await job.save();
      const maxPoints = Number(question?.sessionOptions?.points ?? question?.points ?? 0);
      summaries[question._id] = { graded: 0, zeroed: 0, issues: [] };
      const responses = await Response.find({ questionId: question._id }).lean();
      for (const [studentIndex, grade] of grades.entries()) {
        job.currentStudent = studentIndex + 1; await job.save();
        const markIndex = grade.marks.findIndex((mark) => String(mark.questionId) === String(question._id));
        const student = studentName(usersById.get(String(grade.userId)), grade);
        if (markIndex < 0) {
          job.log.push({ question: `Q${questionIndex + 1}`, student, status: 'skipped', note: 'Skipped: no mark exists for this question.' });
          job.completed += 1; await job.save(); continue;
        }
        if (!job.regrade && !grade.marks[markIndex].needsGrading) {
          job.log.push({ question: `Q${questionIndex + 1}`, student, status: 'skipped', note: 'Skipped: this mark does not need grading.' });
          job.completed += 1; await job.save(); continue;
        }
        const joined = session.quiz ? session.submittedQuiz?.includes(grade.userId) : session.joined?.includes(grade.userId);
        const response = latestResponse(responses.filter((entry) => String(entry.studentUserId) === String(grade.userId)));
        let result = { points: 0, feedback: '', justification: '' };
        if (joined && response) {
          const setup = job.instructions.get(String(question._id)) || {};
          const prompt = [
            `You are grading a student's response to this question: ${plainText(question.content || question.plainText)}.`,
            question.solution ? `Solution: ${plainText(question.solution)}.` : '',
            `Maximum points: ${maxPoints}. Grading instructions: ${setup.grading || ''}`,
            setup.feedback ? `Feedback instructions: ${setup.feedback}` : '',
            `Student response: ${plainText(response.answerWysiwyg || response.answer)}.`,
            'Return only JSON: {"points": number, "feedback": string, "justification": string}. The justification must be a concise, instructor-facing explanation citing the response and grading criteria. Do not reveal private chain-of-thought or hidden reasoning.',
          ].filter(Boolean).join('\n');
          const content = await requestAiCompletion(selected.backend, selected.model.id, [{ role: 'user', content: prompt }]);
          result = parseGrade(content, maxPoints);
          job.log.push({ question: `Q${questionIndex + 1}`, student, status: 'graded', points: result.points, outOf: maxPoints, feedback: result.feedback, justification: result.justification, prompt, response: content });
          summaries[question._id].graded += 1;
        } else {
          const note = joined
            ? 'Assigned 0: no meaningful response was submitted.'
            : 'Assigned 0: the student did not join or submit this activity.';
          result.justification = note;
          job.log.push({ question: `Q${questionIndex + 1}`, student, status: 'zeroed', points: 0, outOf: maxPoints, note, justification: note });
          summaries[question._id].zeroed += 1;
        }
        grade.marks[markIndex].points = result.points;
        grade.marks[markIndex].feedback = result.feedback;
        grade.marks[markIndex].automatic = false;
        grade.marks[markIndex].needsGrading = false;
        recomputeGradeAggregates(grade);
        await grade.save();
        job.completed += 1; await job.save();
      }
    }
    job.status = 'completed'; job.report = { summaries: questions.map((question, index) => ({ question: `Q${index + 1}`, ...summaries[question._id] })), summary: `AI grading completed for ${questions.length} question(s).` }; await job.save();
  } catch (error) { job.status = 'failed'; job.error = error.message || 'AI grading failed'; await job.save(); }
}
