import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import Course from '../../src/models/Course.js';
import Question from '../../src/models/Question.js';
import ResponseModel from '../../src/models/Response.js';
import Session from '../../src/models/Session.js';
import Settings from '../../src/models/Settings.js';
import Grade from '../../src/models/Grade.js';
import { getQuestionResponses, getSessionGradeTable } from '../../src/services/aiCourseTools.js';
import { authenticatedRequest, createApp, createTestUser, getAuthToken } from '../helpers.js';

let app;

beforeEach(async (ctx) => {
  if (mongoose.connection.readyState !== 1) { ctx.skip(); return; }
  app = await createApp();
});

afterEach(async () => { if (app) await app.close(); app = null; vi.restoreAllMocks(); });

async function createCourse(token) {
  const response = await authenticatedRequest(app, 'POST', '/api/v1/courses', { token, payload: {
    name: 'AI Course', deptCode: 'CS', courseNumber: '101', section: '001', semester: 'Fall 2026',
  } });
  return response.json().course;
}

async function configureAi(courseId) {
  await Settings.findOneAndUpdate({ _id: 'settings' }, { $set: {
    AI_Enabled: true,
    AI_EnabledCourses: [courseId],
    AI_Backends: [{ id: 'ollama-local', name: 'Local Ollama', type: 'ollama', url: 'http://ollama.test:11434', apiToken: 'admin-secret', models: [{ id: 'llama3.2', name: 'llama3.2', available: true }] }],
    AI_DefaultBackendId: 'ollama-local', AI_DefaultModelId: 'llama3.2',
  } }, { upsert: true });
}

describe('AI course configuration and chat', () => {
  it('keeps administrator backend tokens private and supports model selection', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const professor = await createTestUser({ email: 'ai-prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, professor);
    const course = await createCourse(token);
    await configureAi(course._id);

    const config = await authenticatedRequest(app, 'GET', `/api/v1/ai/courses/${course._id}/config`, { token });
    expect(config.statusCode).toBe(200);
    expect(config.json().adminBackends[0].apiToken).toBe('');
    expect(config.json().adminBackends[0].apiTokenSet).toBe(true);
    expect(JSON.stringify(config.json())).not.toContain('admin-secret');

    const update = await authenticatedRequest(app, 'PATCH', `/api/v1/ai/courses/${course._id}/config`, {
      token, payload: { enabled: true, selectedBackendId: 'ollama-local', selectedModelId: 'llama3.2' },
    });
    expect(update.statusCode).toBe(200);
    const stored = await Course.findById(course._id).lean();
    expect(stored.aiEnabled).toBe(true);
    expect(stored.aiSelectedModelId).toBe('llama3.2');
  });

  it('stores a private conversation and proxies an Ollama reply', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const professor = await createTestUser({ email: 'ai-chat-prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, professor);
    const course = await createCourse(token);
    await configureAi(course._id);
    await Course.findByIdAndUpdate(course._id, { $set: { aiEnabled: true } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: { content: 'Hello from Ollama' } }), { status: 200 })));

    const created = await authenticatedRequest(app, 'POST', `/api/v1/ai/courses/${course._id}/conversations`, { token });
    const message = await authenticatedRequest(app, 'POST', `/api/v1/ai/courses/${course._id}/conversations/${created.json().conversation._id}/messages`, { token, payload: { content: 'Hello' } });
    expect(message.statusCode).toBe(202);
    expect(message.json().conversation).toMatchObject({ pending: true, messages: [{ content: 'Hello' }] });
    await vi.waitFor(async () => {
      const updated = await authenticatedRequest(app, 'GET', `/api/v1/ai/courses/${course._id}/conversations/${created.json().conversation._id}`, { token });
      expect(updated.json().conversation.messages.map((entry) => entry.content)).toEqual(['Hello', 'Hello from Ollama']);
      expect(updated.json().conversation.pending).toBe(false);
    });
    expect(fetch).toHaveBeenCalledWith('http://ollama.test:11434/api/chat', expect.objectContaining({ method: 'POST' }));
  });

  it('does not give a professor who is only a student in this course AI privileges', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const courseProfessor = await createTestUser({ email: 'course-owner@example.com', roles: ['professor'] });
    const studentProfessor = await createTestUser({ email: 'student-prof@example.com', roles: ['professor', 'student'] });
    const courseOwnerToken = await getAuthToken(app, courseProfessor);
    const studentProfessorToken = await getAuthToken(app, studentProfessor);
    const course = await createCourse(courseOwnerToken);
    await Course.findByIdAndUpdate(course._id, { $addToSet: { students: studentProfessor._id }, $set: { aiEnabled: true } });
    await configureAi(course._id);

    const config = await authenticatedRequest(app, 'GET', `/api/v1/ai/courses/${course._id}/config`, { token: studentProfessorToken });
    const conversation = await authenticatedRequest(app, 'POST', `/api/v1/ai/courses/${course._id}/conversations`, { token: studentProfessorToken });

    expect(config.statusCode).toBe(403);
    expect(conversation.statusCode).toBe(403);
  });

  it('runs MCP tools before answering with course data', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const professor = await createTestUser({ email: 'ai-tool-prof@example.com', roles: ['professor'] });
    const student = await createTestUser({ email: 'student@example.com', firstname: 'Ada', lastname: 'Lovelace' });
    const token = await getAuthToken(app, professor);
    const course = await createCourse(token);
    await Course.findByIdAndUpdate(course._id, { $addToSet: { students: student._id }, $set: { aiEnabled: true } });
    await configureAi(course._id);

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: '', tool_calls: [{ function: { name: 'list_course_students', arguments: {} } }] } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: 'Ada Lovelace is enrolled in the course.' } }), { status: 200 })));

    const created = await authenticatedRequest(app, 'POST', `/api/v1/ai/courses/${course._id}/conversations`, { token });
    const message = await authenticatedRequest(app, 'POST', `/api/v1/ai/courses/${course._id}/conversations/${created.json().conversation._id}/messages`, { token, payload: { content: 'Give me the list of students' } });

    expect(message.statusCode).toBe(202);
    await vi.waitFor(async () => {
      const updated = await authenticatedRequest(app, 'GET', `/api/v1/ai/courses/${course._id}/conversations/${created.json().conversation._id}`, { token });
      expect(updated.json().conversation.messages.at(-1).content).toBe('Ada Lovelace is enrolled in the course.');
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    const secondRequest = JSON.parse(fetch.mock.calls[1][1].body);
    expect(secondRequest.tools.map((tool) => tool.function.name)).toEqual(expect.arrayContaining(['list_course_students', 'list_course_sessions', 'get_session_questions', 'get_question_responses', 'get_session_grade_table']));
    expect(secondRequest.messages.some((entry) => entry.role === 'tool' && entry.content.includes('student@example.com'))).toBe(true);
  });

  it('stops an in-progress AI response and preserves the submitted prompt', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const professor = await createTestUser({ email: 'ai-stop-prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, professor);
    const course = await createCourse(token);
    await configureAi(course._id);
    await Course.findByIdAndUpdate(course._id, { $set: { aiEnabled: true } });
    vi.stubGlobal('fetch', vi.fn((_, options) => new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    })));

    const created = await authenticatedRequest(app, 'POST', `/api/v1/ai/courses/${course._id}/conversations`, { token });
    const conversationId = created.json().conversation._id;
    const message = await authenticatedRequest(app, 'POST', `/api/v1/ai/courses/${course._id}/conversations/${conversationId}/messages`, { token, payload: { content: 'Please wait' } });
    expect(message.statusCode).toBe(202);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    const stopped = await authenticatedRequest(app, 'POST', `/api/v1/ai/courses/${course._id}/conversations/${conversationId}/stop`, { token });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().conversation).toMatchObject({ pending: false, pendingError: 'AI response stopped', messages: [{ content: 'Please wait' }] });
  });

  it('returns only the highest response attempt for a session question', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const professor = await createTestUser({ email: 'attempt-prof@example.com', roles: ['professor'] });
    const student = await createTestUser({ email: 'attempt-student@example.com', firstname: 'Grace', lastname: 'Hopper' });
    const token = await getAuthToken(app, professor);
    const course = await createCourse(token);
    await Course.findByIdAndUpdate(course._id, { $addToSet: { students: student._id } });
    const question = await Question.create({ type: 1, plainText: 'What is 2 + 2?', creator: professor._id, courseId: course._id });
    const session = await Session.create({ name: 'Lecture 9', courseId: course._id, creator: professor._id, status: 'done', questions: [question._id] });
    await ResponseModel.create({ questionId: question._id, studentUserId: student._id, attempt: 1, answer: '3', createdAt: new Date('2026-08-10T10:00:00.000Z') });
    await ResponseModel.create({ questionId: question._id, studentUserId: student._id, attempt: 2, answer: '4', createdAt: new Date('2026-08-10T10:01:00.000Z') });

    const result = await getQuestionResponses(course._id, session._id, question._id);

    expect(result.attempt).toBe(2);
    expect(result.responses).toHaveLength(1);
    expect(result.responses[0]).toMatchObject({ answer: '4', student: { name: 'Grace Hopper', email: 'attempt-student@example.com' } });
  });

  it('returns a bounded, sortable session grade table with question summaries', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const professor = await createTestUser({ email: 'grade-table-prof@example.com', roles: ['professor'] });
    const ada = await createTestUser({ email: 'grade-table-ada@example.com', firstname: 'Ada', lastname: 'Lovelace' });
    const grace = await createTestUser({ email: 'grade-table-grace@example.com', firstname: 'Grace', lastname: 'Hopper' });
    const token = await getAuthToken(app, professor);
    const course = await createCourse(token);
    await Course.findByIdAndUpdate(course._id, { $addToSet: { students: { $each: [ada._id, grace._id] } } });
    const firstQuestion = await Question.create({ type: 1, plainText: 'First question', creator: professor._id, courseId: course._id });
    const secondQuestion = await Question.create({ type: 1, plainText: 'Second question', creator: professor._id, courseId: course._id });
    const session = await Session.create({ name: 'L2', courseId: course._id, creator: professor._id, status: 'done', questions: [firstQuestion._id, secondQuestion._id] });
    await Grade.create([
      { userId: ada._id, courseId: course._id, sessionId: session._id, points: 1, outOf: 2, marks: [{ questionId: firstQuestion._id, points: 1, outOf: 1 }, { questionId: secondQuestion._id, points: 0, outOf: 1 }] },
      { userId: grace._id, courseId: course._id, sessionId: session._id, points: 2, outOf: 2, marks: [{ questionId: firstQuestion._id, points: 1, outOf: 1 }, { questionId: secondQuestion._id, points: 1, outOf: 1 }] },
    ]);

    const result = await getSessionGradeTable(course._id, session._id, { limit: 1, sortBy: 'total_points', order: 'desc' });

    expect(result).toMatchObject({ student_count: 2, returned_count: 1, next_offset: 1 });
    expect(result.students[0]).toMatchObject({ student: { name: 'Grace Hopper' }, total_points: 2, total_out_of: 2 });
    expect(result.question_summaries[1]).toMatchObject({ number: 2, average_points: 0.5, average_percentage: 50 });
  });
});
