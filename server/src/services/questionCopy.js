import Question from '../models/Question.js';
import Session from '../models/Session.js';
import { buildSessionResponseTracking } from '../utils/sessionResponseTracking.js';
import { applyQuestionManagerFingerprint } from './questionManager.js';

function buildCopiedSessionOptions(sessionOptions, { preservePoints = false } = {}) {
  const sourceOptions = sessionOptions && typeof sessionOptions === 'object' ? sessionOptions : {};
  const next = {
    points: 1,
  };

  if (preservePoints && sourceOptions.points !== undefined) next.points = sourceOptions.points;
  if (sourceOptions.maxAttempts !== undefined) next.maxAttempts = sourceOptions.maxAttempts;
  if (Array.isArray(sourceOptions.attemptWeights)) next.attemptWeights = [...sourceOptions.attemptWeights];

  next.hidden = true;
  next.stats = false;
  next.correct = false;
  next.attempts = [];

  return next;
}

export async function copyQuestionToSession({
  sourceQuestion,
  targetSessionId,
  targetCourseId,
  userId,
  addToSession = true,
  preservePoints,
}) {
  if (!sourceQuestion) {
    throw new Error('Source question is required');
  }

  const sourceObject = sourceQuestion.toObject ? sourceQuestion.toObject() : sourceQuestion;
  const sourceQuestionId = String(sourceObject._id || sourceQuestion._id || '');
  const originalQuestionId = String(sourceObject.originalQuestion || sourceQuestionId);
  const originalCourseId = String(sourceObject.originalCourse || sourceObject.courseId || targetCourseId || '');
  const copiedPayload = { ...sourceObject };
  delete copiedPayload._id;
  delete copiedPayload.__v;
  delete copiedPayload.updatedAt;
  delete copiedPayload.sessionProperties;
  copiedPayload.sessionOptions = buildCopiedSessionOptions(sourceObject.sessionOptions, {
    preservePoints: preservePoints !== false,
  });

  const copy = await Question.create(applyQuestionManagerFingerprint({
    ...copiedPayload,
    creator: String(sourceObject.creator || userId),
    owner: userId,
    sessionId: targetSessionId,
    courseId: targetCourseId,
    originalQuestion: originalQuestionId,
    originalCourse: originalCourseId,
    createdAt: new Date(),
    lastEditedAt: new Date(),
    approved: true,
    studentCreated: !!sourceObject.studentCreated,
  }, sourceObject.questionManager));

  if (addToSession) {
    const session = await Session.findById(targetSessionId).lean();
    const nextQuestionIds = [...new Set([
      ...((session?.questions || []).map((questionId) => String(questionId))),
      String(copy._id),
    ])];
    const nextResponseTracking = buildSessionResponseTracking(
      nextQuestionIds,
      session?.questionResponseCounts
    );

    await Session.findByIdAndUpdate(targetSessionId, {
      $set: {
        questions: nextQuestionIds,
        hasResponses: nextResponseTracking.hasResponses,
        questionResponseCounts: nextResponseTracking.questionResponseCounts,
      },
    });
  }

  return copy;
}

export async function copyQuestionToLibrary({
  sourceQuestion,
  targetCourseId,
  userId,
  forceStudentCopy = false,
}) {
  if (!sourceQuestion) {
    throw new Error('Source question is required');
  }

  const sourceObject = sourceQuestion.toObject ? sourceQuestion.toObject() : sourceQuestion;
  const copiedPayload = { ...sourceObject };
  delete copiedPayload._id;
  delete copiedPayload.__v;
  delete copiedPayload.updatedAt;
  delete copiedPayload.sessionOptions;

  return Question.create(applyQuestionManagerFingerprint({
    ...copiedPayload,
    creator: String(sourceObject.creator || userId),
    owner: userId,
    sessionId: '',
    courseId: String(targetCourseId || sourceObject.courseId || ''),
    originalQuestion: String(sourceObject.originalQuestion || sourceObject._id || ''),
    originalCourse: String(sourceObject.originalCourse || sourceObject.courseId || targetCourseId || ''),
    createdAt: new Date(),
    lastEditedAt: new Date(),
    public: forceStudentCopy ? false : !!sourceObject.public,
    publicOnQlicker: forceStudentCopy ? false : !!sourceObject.publicOnQlicker,
    publicOnQlickerForStudents: forceStudentCopy ? false : !!sourceObject.publicOnQlickerForStudents,
    approved: forceStudentCopy ? false : true,
    studentCreated: forceStudentCopy ? true : !!sourceObject.studentCreated,
    studentCopyOfPublic: forceStudentCopy ? true : !!sourceObject.studentCopyOfPublic,
  }, sourceObject.questionManager));
}
