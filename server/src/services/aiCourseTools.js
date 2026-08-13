import Course from '../models/Course.js';
import Question from '../models/Question.js';
import Response from '../models/Response.js';
import Session from '../models/Session.js';
import User from '../models/User.js';

const MAX_RESPONSE_RESULTS = 500;

function formatStudent(student) {
  const firstname = String(student?.profile?.firstname || '').trim();
  const lastname = String(student?.profile?.lastname || '').trim();
  const email = String(student?.emails?.[0]?.address || student?.email || '').trim();
  return {
    student_id: String(student?._id || ''),
    name: [firstname, lastname].filter(Boolean).join(' ') || email || 'Unknown student',
    email,
  };
}

function sessionSortTime(session) {
  return new Date(session?.date || session?.quizStart || session?.createdAt || 0).getTime();
}

async function requireCourseSession(courseId, sessionId) {
  const session = await Session.findOne({ _id: String(sessionId), courseId: String(courseId) }).lean();
  if (!session || session.studentCreated) throw new Error('Session not found in this course');
  return session;
}

async function loadOrderedQuestions(session) {
  const questionIds = Array.isArray(session.questions) ? session.questions.map(String) : [];
  if (questionIds.length === 0) return [];
  const questions = await Question.find({ _id: { $in: questionIds } }).lean();
  const byId = new Map(questions.map((question) => [String(question._id), question]));
  return questionIds.map((id) => byId.get(id)).filter(Boolean);
}

function serializeQuestion(question, index) {
  return {
    question_id: String(question._id),
    number: index + 1,
    type: question.type,
    prompt: question.plainText || question.content || '',
    options: (question.options || []).map((option, optionIndex) => ({
      index: optionIndex + 1,
      text: option.plainText || option.content || option.answer || '',
      correct: !!option.correct,
    })),
  };
}

function responseTimestamp(response) {
  return new Date(response?.updatedAt || response?.submittedAt || response?.createdAt || 0).getTime();
}

function serializeAnswer(answer) {
  if (typeof answer === 'string' || typeof answer === 'number' || typeof answer === 'boolean') return answer;
  if (answer === null || answer === undefined) return '';
  return JSON.stringify(answer);
}

export async function listCourseStudents(courseId) {
  const course = await Course.findById(courseId).select('students').lean();
  if (!course) throw new Error('Course not found');
  const students = (course.students || []).length > 0
    ? await User.find({ _id: { $in: course.students } }).select('_id profile emails email').lean()
    : [];
  return {
    students: students.map(formatStudent).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export async function listCourseSessions(courseId) {
  const sessions = await Session.find({ courseId: String(courseId), studentCreated: { $ne: true } })
    .select('_id name description status date quiz quizStart quizEnd practiceQuiz reviewable createdAt questions')
    .lean();
  return {
    sessions: sessions.sort((a, b) => sessionSortTime(b) - sessionSortTime(a)).map((session) => ({
      session_id: String(session._id),
      name: session.name || '',
      description: session.description || '',
      status: session.status || '',
      date: session.date || session.quizStart || session.createdAt || null,
      quiz: !!session.quiz,
      practice_quiz: !!session.practiceQuiz,
      reviewable: !!session.reviewable,
      question_count: Array.isArray(session.questions) ? session.questions.length : 0,
    })),
  };
}

export async function getSessionQuestions(courseId, sessionId) {
  const session = await requireCourseSession(courseId, sessionId);
  const questions = await loadOrderedQuestions(session);
  return {
    session: { session_id: String(session._id), name: session.name || '' },
    questions: questions.map(serializeQuestion),
  };
}

export async function getQuestionResponses(courseId, sessionId, questionId) {
  const session = await requireCourseSession(courseId, sessionId);
  const orderedQuestions = await loadOrderedQuestions(session);
  const question = orderedQuestions.find((entry) => String(entry._id) === String(questionId));
  if (!question) throw new Error('Question not found in this session');

  const allResponses = await Response.find({ questionId: String(question._id) }).lean();
  const highestAttempt = allResponses.reduce((highest, response) => Math.max(highest, Number(response.attempt) || 0), 0);
  const finalAttemptResponses = allResponses.filter((response) => Number(response.attempt) === highestAttempt);
  const latestByStudent = new Map();
  finalAttemptResponses.forEach((response) => {
    const studentId = String(response.studentUserId || '');
    if (!studentId || responseTimestamp(response) < responseTimestamp(latestByStudent.get(studentId))) return;
    latestByStudent.set(studentId, response);
  });

  const responses = [...latestByStudent.values()]
    .sort((a, b) => responseTimestamp(b) - responseTimestamp(a));
  const truncated = responses.length > MAX_RESPONSE_RESULTS;
  const displayedResponses = responses.slice(0, MAX_RESPONSE_RESULTS);
  const users = displayedResponses.length > 0
    ? await User.find({ _id: { $in: displayedResponses.map((response) => response.studentUserId) } }).select('_id profile emails email').lean()
    : [];
  const studentById = new Map(users.map((student) => [String(student._id), formatStudent(student)]));

  return {
    session: { session_id: String(session._id), name: session.name || '' },
    question: serializeQuestion(question, orderedQuestions.indexOf(question)),
    attempt: highestAttempt || null,
    response_count: responses.length,
    truncated,
    responses: displayedResponses.map((response) => ({
      student: studentById.get(String(response.studentUserId)) || { student_id: String(response.studentUserId || ''), name: 'Unknown student', email: '' },
      answer: serializeAnswer(response.answer),
      answer_wysiwyg: response.answerWysiwyg || '',
      correct: response.correct,
      mark: response.mark,
      submitted_at: response.submittedAt || response.updatedAt || response.createdAt || null,
    })),
  };
}
