import Question from '../models/Question.js';
import Session from '../models/Session.js';
import Response from '../models/Response.js';
import Grade from '../models/Grade.js';
import { generateMeteorId } from '../utils/meteorId.js';
import { buildSessionResponseTracking } from '../utils/sessionResponseTracking.js';
import { buildCopiedSessionOptions } from './questionCopy.js';
import { mergeSessionQuestionTags } from './sessionQuestionTags.js';
import { getQuestionPoints } from './grading.js';

// Run with application writers stopped. The snapshot check also rejects session
// edits between inspection and replacement; it is not a cross-collection lock.
export async function repairSessionQuestionReferences({ sessionId, apply = false }) {
  const session = await Session.collection.findOne({ _id: sessionId });
  if (!session) return { sessionId, status: 'missing-session' };
  const ids = session.questions || [];
  const questions = await Question.collection.find({ _id: { $in: ids } }).toArray();
  const byId = new Map(questions.map((question) => [question._id, question]));
  const seen = new Set();
  const replacements = [];
  const missingIds = [];
  ids.forEach((id, index) => {
    const question = byId.get(id);
    if (!question) missingIds.push(id);
    else if (seen.has(id) || question.sessionId !== sessionId || question.courseId !== session.courseId) {
      replacements.push({ position: index + 1, sourceQuestionId: id });
    }
    seen.add(id);
  });
  const report = { sessionId, courseId: session.courseId, replacements };
  if (!replacements.length && !missingIds.length) return { ...report, status: 'unchanged' };

  const [response, grade] = await Promise.all([
    Response.collection.findOne({ questionId: { $in: ids } }, { projection: { _id: 1 } }),
    Grade.collection.findOne({ $or: [
      { sessionId }, { 'marks.questionId': { $in: ids } },
    ] }, { projection: { _id: 1 } }),
  ]);
  const reasons = [];
  if (missingIds.length) reasons.push('missing-question-documents');
  if (session.status !== 'hidden' || session.reviewable) reasons.push('session-not-hidden');
  if ((session.joined || []).length || (session.joinRecords || []).length
      || (session.submittedQuiz || []).length || session.hasResponses
      || Object.values(session.questionResponseCounts || {}).some((count) => Number(count) > 0)) {
    reasons.push('recorded-participation');
  }
  if (response) reasons.push('existing-responses');
  if (grade) reasons.push('existing-grades');
  if (reasons.length) return { ...report, status: 'manual-review', reasons, missingIds: [...new Set(missingIds)] };
  if (!apply) return { ...report, status: 'would-repair' };

  const createdIds = [];
  const nextIds = [...ids];
  try {
    for (const replacement of replacements) {
      const source = byId.get(replacement.sourceQuestionId);
      const copyId = generateMeteorId();
      // Raw insertion preserves unknown legacy question fields, including old
      // solution representations. Only identity, provenance and live state change.
      const copy = {
        ...source,
        _id: copyId,
        sessionId,
        courseId: session.courseId,
        originalQuestion: source.originalQuestion || source._id,
        originalCourse: source.originalCourse || source.courseId || session.courseId,
        createdAt: new Date(),
        lastEditedAt: new Date(),
        sessionOptions: buildCopiedSessionOptions({ ...source.sessionOptions, points: getQuestionPoints(source) }, { preservePoints: true }),
        tags: mergeSessionQuestionTags(source.tags, session.tags),
      };
      delete copy.sessionProperties;
      delete copy.__v;
      delete copy.updatedAt;
      await Question.collection.insertOne(copy);
      createdIds.push(copyId);
      nextIds[replacement.position - 1] = copyId;
      replacement.newQuestionId = copyId;
    }
  } catch (error) {
    await Question.collection.deleteMany({ _id: { $in: createdIds } });
    throw error;
  }

  const currentIndex = ids.indexOf(session.currentQuestion);
  // Match the inspected fields exactly, including legacy absence of optional
  // fields. An uncertain write failure deliberately leaves copies intact rather
  // than risking deletion of documents the session may now reference.
  const guard = { ...session };
  for (const field of ['joined', 'joinRecords', 'submittedQuiz', 'hasResponses', 'questionResponseCounts', 'reviewable']) {
    if (!(field in session)) guard[field] = { $exists: false };
  }
  const result = await Session.collection.updateOne(guard, { $set: {
    questions: nextIds,
    currentQuestion: currentIndex >= 0 ? nextIds[currentIndex] : (session.currentQuestion || ''),
    ...buildSessionResponseTracking(nextIds),
  } });
  if (!result.matchedCount) {
    await Question.collection.deleteMany({ _id: { $in: createdIds } });
    return { ...report, status: 'conflict', reasons: ['session-changed-during-repair'] };
  }
  return { ...report, status: 'repaired' };
}
