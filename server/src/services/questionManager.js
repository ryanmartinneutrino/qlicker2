import crypto from 'node:crypto';
import { normalizeTags } from './questionImportExport.js';

function normalizeString(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeHtmlFragment(value) {
  return normalizeString(String(value || '').replace(/>\s+</g, '><'));
}

function normalizeOptionSignature(option = {}) {
  return {
    content: normalizeHtmlFragment(option.content || option.answer || ''),
    plainText: normalizeString(option.plainText || option.answer || ''),
    correct: !!option.correct,
  };
}

function normalizeQuestionSignature(question = {}) {
  return {
    type: Number(question.type),
    content: normalizeHtmlFragment(question.content || ''),
    plainText: normalizeString(question.plainText || ''),
    options: Array.isArray(question.options)
      ? question.options.map((option) => normalizeOptionSignature(option))
      : [],
    correctNumerical: question.correctNumerical ?? null,
    toleranceNumerical: question.toleranceNumerical ?? null,
    solution: normalizeHtmlFragment(question.solution || ''),
    solutionPlainText: normalizeString(question.solution_plainText || ''),
    imagePath: normalizeString(question.imagePath || ''),
  };
}

export function buildQuestionManagerFingerprint(question = {}) {
  const signature = normalizeQuestionSignature(question);
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(signature))
    .digest('hex');
}

export function applyQuestionManagerFingerprint(payload = {}, existingQuestionManager = {}) {
  const fingerprint = buildQuestionManagerFingerprint(payload);
  return {
    ...payload,
    questionManager: {
      ...existingQuestionManager,
      ...(payload.questionManager || {}),
      fingerprint,
    },
  };
}

export function buildQuestionManagerImportMetadata({
  existingQuestionManager = {},
  importedAt = new Date(),
  importedBy = '',
  importFormat = '',
  importFilename = '',
  importIgnoredPoints = false,
} = {}) {
  return {
    ...existingQuestionManager,
    importedAt,
    importedBy: String(importedBy || '').trim(),
    importFormat: String(importFormat || '').trim(),
    importFilename: String(importFilename || '').trim(),
    importIgnoredPoints: !!importIgnoredPoints,
  };
}

export function buildDetachedQuestionManagerCopyPayload({
  sourceQuestion,
  userId,
}) {
  const source = sourceQuestion?.toObject ? sourceQuestion.toObject() : sourceQuestion;
  const sourceQuestionId = String(source?._id || '').trim();
  const originalQuestionId = String(source?.originalQuestion || sourceQuestionId).trim();
  const originalCourseId = String(source?.originalCourse || source?.courseId || '').trim();
  const points = Number(source?.sessionOptions?.points);

  return applyQuestionManagerFingerprint({
    type: Number(source?.type),
    content: source?.content || '',
    plainText: source?.plainText || '',
    options: Array.isArray(source?.options) ? source.options : [],
    correctNumerical: source?.correctNumerical,
    toleranceNumerical: source?.toleranceNumerical,
    solution: source?.solution || '',
    solution_plainText: source?.solution_plainText || '',
    creator: String(source?.creator || userId),
    owner: String(userId || ''),
    originalQuestion: originalQuestionId,
    originalCourse: originalCourseId,
    sessionId: '',
    courseId: '',
    public: false,
    publicOnQlicker: false,
    publicOnQlickerForStudents: false,
    createdAt: new Date(),
    lastEditedAt: new Date(),
    approved: true,
    tags: normalizeTags(source?.tags || []),
    sessionOptions: Number.isFinite(points) && points > 0 ? { points } : { points: 1 },
    imagePath: source?.imagePath || '',
    studentCopyOfPublic: false,
    studentCreated: false,
    questionManager: {
      detachedFromQuestionId: sourceQuestionId,
    },
  });
}
