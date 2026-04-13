import Course from '../models/Course.js';
import Session from '../models/Session.js';

function addUserId(targetSet, value) {
  const normalized = String(value || '').trim();
  if (!normalized) return;
  targetSet.add(normalized);
}

async function getQuestionManagerCourseId(question = {}) {
  const directCourseId = String(question?.courseId || '').trim();
  if (directCourseId) return directCourseId;

  const sessionId = String(question?.sessionId || '').trim();
  if (!sessionId) return '';
  const session = await Session.findById(sessionId).select('courseId').lean();
  return String(session?.courseId || '').trim();
}

export async function getQuestionManagerAudienceUserIds(question = {}) {
  const audience = new Set();
  addUserId(audience, question?.owner);
  addUserId(audience, question?.creator);

  const courseId = await getQuestionManagerCourseId(question);
  if (!courseId) {
    return [...audience];
  }

  const course = await Course.findById(courseId).select('instructors').lean();
  (course?.instructors || []).forEach((userId) => addUserId(audience, userId));
  return [...audience];
}

export async function notifyQuestionManagerChanged(app, {
  questions = [],
  deletedQuestionIds = [],
} = {}) {
  if (typeof app?.wsSendToUsers !== 'function') return;

  const audience = new Set();
  for (const question of questions) {
    // eslint-disable-next-line no-await-in-loop
    const userIds = await getQuestionManagerAudienceUserIds(question);
    userIds.forEach((userId) => addUserId(audience, userId));
  }

  if (audience.size === 0 || (questions.length === 0 && deletedQuestionIds.length === 0)) return;

  app.wsSendToUsers([...audience], 'question-manager:changed', {
    questionIds: questions.map((question) => String(question?._id || '')).filter(Boolean),
    deletedQuestionIds: deletedQuestionIds.map((questionId) => String(questionId || '')).filter(Boolean),
    changedAt: new Date().toISOString(),
  });
}
