import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import Course from '../../src/models/Course.js';
import Question from '../../src/models/Question.js';
import ResponseModel from '../../src/models/Response.js';
import Session from '../../src/models/Session.js';
import Settings from '../../src/models/Settings.js';
import Grade from '../../src/models/Grade.js';
import AiGradingJob from '../../src/models/AiGradingJob.js';
import Post from '../../src/models/Post.js';
import AiConversation from '../../src/models/AiConversation.js';
import AiResponseSummary from '../../src/models/AiResponseSummary.js';
import { getCourseGradeTable, getQuestionResponses, getSessionGradeTable } from '../../src/services/aiCourseTools.js';
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
    AI_Backends: [{ id: 'ollama-local', name: 'Local Ollama', type: 'ollama', url: 'http://ollama.test:11434', apiToken: 'admin-secret', models: [
      { id: 'llama3.2', name: 'llama3.2', available: true },
      { id: 'qwen3', name: 'qwen3', available: true },
    ] }],
    AI_DefaultBackendId: 'ollama-local', AI_DefaultModelId: 'llama3.2',
  } }, { upsert: true });
}

describe('AI course configuration and chat', () => {
  it('halts an orphaned AI grading job and creates a durable partial report', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const professor = await createTestUser({ email: 'ai-halt-prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, professor);
    const course = await createCourse(token);
    const session = await Session.create({
      name: 'Stuck grading session',
      courseId: course._id,
      creator: professor._id,
      status: 'done',
      aiGradingLog: null,
    });
    const job = await AiGradingJob.create({
      courseId: course._id,
      sessionId: session._id,
      ownerId: professor._id,
      questionIds: ['question-1'],
      status: 'running',
      completed: 3,
      total: 10,
    });

    const halted = await authenticatedRequest(
      app,
      'POST',
      `/api/v1/ai/courses/${course._id}/sessions/${session._id}/ai-grading/halt`,
      { token }
    );

    expect(halted.statusCode).toBe(200);
    expect(halted.json().job).toMatchObject({ _id: job._id, status: 'halted', completed: 3, total: 10 });
    expect(halted.json().job.report.summary).toContain('halted after 3 of 10');
    expect(halted.json().log.runs).toEqual([
      expect.objectContaining({
        jobId: job._id,
        status: 'halted',
        entries: [expect.objectContaining({ status: 'halted', note: 'AI grading was halted by an instructor.' })],
      }),
    ]);
    expect((await AiGradingJob.findById(job._id).lean()).status).toBe('halted');
  });

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
    expect(config.json().approvedModels).toEqual([
      expect.objectContaining({ backendId: 'ollama-local', modelId: 'llama3.2', studentAvailable: false }),
    ]);
    expect(config.json()).toMatchObject({
      instructorChatMaxToolRounds: 20,
      studentChatMaxToolRounds: 5,
    });

    const update = await authenticatedRequest(app, 'PATCH', `/api/v1/ai/courses/${course._id}/config`, {
      token,
      payload: {
        enabled: true,
        instructorChatMaxToolRounds: 24,
        defaultBackendId: 'ollama-local',
        defaultModelId: 'qwen3',
        modelPolicies: [
          { backendId: 'ollama-local', modelId: 'llama3.2', studentAvailable: true },
          { backendId: 'ollama-local', modelId: 'qwen3', studentAvailable: false },
        ],
      },
    });
    expect(update.statusCode).toBe(200);
    const stored = await Course.findById(course._id).lean();
    expect(stored.aiEnabled).toBe(true);
    expect(stored.aiInstructorChatMaxToolRounds).toBe(24);
    expect(stored.aiDefaultModelId).toBe('qwen3');
    expect(stored.aiModelPolicies).toEqual([
      expect.objectContaining({ backendId: 'ollama-local', modelId: 'llama3.2', studentAvailable: true }),
      expect.objectContaining({ backendId: 'ollama-local', modelId: 'qwen3', studentAvailable: false }),
    ]);

    const studentChatUpdate = await authenticatedRequest(app, 'PATCH', `/api/v1/ai/courses/${course._id}/config`, {
      token,
      payload: {
        studentChatEnabled: true,
        studentChatGuidance: 'Stay focused on mechanics.',
        studentChatMaxToolRounds: 7,
        studentDefaultBackendId: 'ollama-local',
        studentDefaultModelId: 'llama3.2',
      },
    });
    expect(studentChatUpdate.statusCode).toBe(200);
    const updatedConfig = await authenticatedRequest(app, 'GET', `/api/v1/ai/courses/${course._id}/config`, { token });
    expect(updatedConfig.json()).toMatchObject({
      studentChatEnabled: true,
      studentChatGuidance: 'Stay focused on mechanics.',
      instructorChatMaxToolRounds: 24,
      studentChatMaxToolRounds: 7,
      studentDefaultBackendId: 'ollama-local',
      studentDefaultModelId: 'llama3.2',
    });

    const invalidLimit = await authenticatedRequest(app, 'PATCH', `/api/v1/ai/courses/${course._id}/config`, {
      token,
      payload: { instructorChatMaxToolRounds: 0 },
    });
    expect(invalidLimit.statusCode).toBe(400);
    expect((await Course.findById(course._id).lean()).aiInstructorChatMaxToolRounds).toBe(24);
  });

  it('persists professor-managed backend tokens across masked saves and an app restart', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const professor = await createTestUser({ email: 'ai-token-prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, professor);
    const course = await createCourse(token);
    await configureAi(course._id);
    await Settings.findByIdAndUpdate('settings', { $addToSet: { AI_AllowCourseBackendCourses: course._id } });
    const backend = {
      id: 'course-ollama',
      name: 'Course Ollama',
      type: 'ollama',
      url: 'http://course-ollama.test:11434',
      apiToken: 'persistent-course-token',
      models: [{ id: 'course-model', name: 'course-model', available: true }],
    };

    const saved = await authenticatedRequest(app, 'PATCH', `/api/v1/ai/courses/${course._id}/config`, {
      token,
      payload: { backends: [backend] },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().courseBackends[0]).toMatchObject({ apiToken: '', apiTokenSet: true });

    const maskedRoundTrip = await authenticatedRequest(app, 'PATCH', `/api/v1/ai/courses/${course._id}/config`, {
      token,
      payload: { backends: saved.json().courseBackends },
    });
    expect(maskedRoundTrip.statusCode).toBe(200);
    expect((await Course.findById(course._id).lean()).aiBackends[0].apiToken).toBe('persistent-course-token');

    await app.close();
    app = await createApp();
    const reloaded = await authenticatedRequest(app, 'GET', `/api/v1/ai/courses/${course._id}/config`, { token });
    expect(reloaded.json().courseBackends[0]).toMatchObject({ apiToken: '', apiTokenSet: true });
    expect((await Course.findById(course._id).lean()).aiBackends[0].apiToken).toBe('persistent-course-token');

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      models: [{ name: 'course-model' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const discovered = await authenticatedRequest(app, 'POST', '/api/v1/ai/discover-models', {
      token,
      payload: {
        backendId: 'course-ollama',
        courseId: course._id,
        type: 'ollama',
        url: 'http://course-ollama.test:11434',
        apiToken: '',
      },
    });
    expect(discovered.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://course-ollama.test:11434/api/tags',
      expect.objectContaining({ headers: { authorization: 'Bearer persistent-course-token' } })
    );
  });

  it('uses a stored administrator backend token for model discovery', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const admin = await createTestUser({ email: 'ai-discovery-admin@example.com', roles: ['admin'] });
    const token = await getAuthToken(app, admin);
    await configureAi('course-1');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      models: [{ name: 'llama3.2' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const discovered = await authenticatedRequest(app, 'POST', '/api/v1/ai/discover-models', {
      token,
      payload: {
        backendId: 'ollama-local',
        type: 'ollama',
        url: 'http://ollama.test:11434',
        apiToken: '',
      },
    });

    expect(discovered.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://ollama.test:11434/api/tags',
      expect.objectContaining({ headers: { authorization: 'Bearer admin-secret' } })
    );
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

  it('unblocks an orphaned failed AI chat request when the conversation is reloaded', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const professor = await createTestUser({ email: 'ai-orphan-prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, professor);
    const course = await createCourse(token);
    const conversation = await AiConversation.create({
      courseId: course._id,
      ownerId: professor._id,
      pending: true,
      pendingMessageId: 'orphaned-message',
      messages: [{ _id: 'orphaned-message', role: 'user', content: 'This request failed.' }],
    });

    const response = await authenticatedRequest(
      app,
      'GET',
      `/api/v1/ai/courses/${course._id}/conversations/${conversation._id}`,
      { token }
    );

    expect(response.statusCode).toBe(200);
    expect(response.json().conversation).toMatchObject({
      pending: false,
      pendingError: 'The previous AI request did not complete. You can send another message.',
    });
    expect(await AiConversation.findById(conversation._id).lean()).toMatchObject({ pending: false, pendingMessageId: '' });

    const cleared = await authenticatedRequest(
      app,
      'DELETE',
      `/api/v1/ai/courses/${course._id}/conversations/${conversation._id}/pending-error`,
      { token }
    );
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().conversation.pendingError).toBe('');
    expect((await AiConversation.findById(conversation._id).lean()).pendingError).toBe('');
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
    expect(secondRequest.tools.map((tool) => tool.function.name)).toEqual(expect.arrayContaining(['get_conversation_history', 'list_course_students', 'list_course_sessions', 'get_session_questions', 'get_question_responses', 'get_session_grade_table', 'get_course_grade_table', 'list_course_chat_topics', 'get_course_chat_topic', 'draft_course_chat_message', 'publish_course_chat_draft', 'create_course_session', 'edit_course_session', 'list_course_questions', 'create_course_question', 'edit_course_question']));
    expect(secondRequest.messages.some((entry) => entry.role === 'tool' && entry.content.includes('student@example.com'))).toBe(true);
  });

  it('uses the course maximum for professor AI chat tool rounds', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const professor = await createTestUser({ email: 'ai-round-limit-prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, professor);
    const course = await createCourse(token);
    await Course.findByIdAndUpdate(course._id, { $set: { aiEnabled: true, aiInstructorChatMaxToolRounds: 1 } });
    await configureAi(course._id);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      message: { content: '', tool_calls: [{ function: { name: 'list_course_students', arguments: {} } }] },
    }), { status: 200 })));

    const created = await authenticatedRequest(app, 'POST', `/api/v1/ai/courses/${course._id}/conversations`, { token });
    const conversationId = created.json().conversation._id;
    await authenticatedRequest(app, 'POST', `/api/v1/ai/courses/${course._id}/conversations/${conversationId}/messages`, {
      token,
      payload: { content: 'Keep checking the student list.' },
    });

    await vi.waitFor(async () => {
      const updated = await AiConversation.findById(conversationId).lean();
      expect(updated).toMatchObject({
        pending: false,
        pendingError: 'AI backend exceeded the configured maximum of 1 internal tool rounds',
      });
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('creates a quiz through the instructor MCP tool and always reports its schedule', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const professor = await createTestUser({ email: 'ai-author-prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, professor);
    const course = await createCourse(token);
    await Course.findByIdAndUpdate(course._id, { $set: { aiEnabled: true } });
    await configureAi(course._id);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: '', tool_calls: [{ function: {
        name: 'create_course_session',
        arguments: { name: 'Generated Quiz', type: 'quiz' },
      } }] } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: 'The quiz was created.' } }), { status: 200 })));

    const created = await authenticatedRequest(app, 'POST', `/api/v1/ai/courses/${course._id}/conversations`, { token });
    const conversationId = created.json().conversation._id;
    await authenticatedRequest(app, 'POST', `/api/v1/ai/courses/${course._id}/conversations/${conversationId}/messages`, {
      token,
      payload: { content: 'Create a quiz.' },
    });

    await vi.waitFor(async () => {
      const updated = await authenticatedRequest(app, 'GET', `/api/v1/ai/courses/${course._id}/conversations/${conversationId}`, { token });
      expect(updated.json().conversation.messages.at(-1).content).toContain('Quiz schedule: Generated Quiz');
    });
    const quiz = await Session.findOne({ courseId: course._id, name: 'Generated Quiz' }).lean();
    expect(quiz).toMatchObject({ quiz: true, status: 'hidden' });
    expect(new Date(quiz.quizEnd).getTime() - new Date(quiz.quizStart).getTime()).toBe(12 * 60 * 60 * 1000);
    expect(new Date(quiz.quizStart).getMinutes()).toBe(0);
  });

  it('shows a course chat draft and requires its exact later-turn approval before posting', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const professor = await createTestUser({ email: 'ai-course-chat-prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, professor);
    const course = await createCourse(token);
    await Course.findByIdAndUpdate(course._id, { $set: { aiEnabled: true, courseChatEnabled: true } });
    await configureAi(course._id);
    const target = await Post.create({
      scopeType: 'course',
      courseId: course._id,
      authorId: 'student-1',
      authorRole: 'student',
      title: 'When is the assignment due?',
      body: 'I cannot find the deadline.',
    });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: '', tool_calls: [{ function: {
        name: 'draft_course_chat_message',
        arguments: {
          type: 'response',
          target_topic_id: target._id,
          body: 'The assignment is due Friday at 5 PM.',
        },
      } }] } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: 'Please review this response.' } }), { status: 200 })));

    const created = await authenticatedRequest(app, 'POST', `/api/v1/ai/courses/${course._id}/conversations`, { token });
    const conversationId = created.json().conversation._id;
    await authenticatedRequest(app, 'POST', `/api/v1/ai/courses/${course._id}/conversations/${conversationId}/messages`, {
      token,
      payload: { content: 'Post a response telling them the deadline is Friday at 5 PM.' },
    });

    let approvalPhrase = '';
    await vi.waitFor(async () => {
      const updated = await authenticatedRequest(app, 'GET', `/api/v1/ai/courses/${course._id}/conversations/${conversationId}`, { token });
      const assistantContent = updated.json().conversation.messages.at(-1).content;
      expect(assistantContent).toContain('Course chat draft — not posted');
      expect(assistantContent).toContain('The assignment is due Friday at 5 PM.');
      approvalPhrase = assistantContent.match(/Approve course chat draft [A-Za-z0-9]+/)?.[0] || '';
      expect(approvalPhrase).toBeTruthy();
    });
    expect((await Post.findById(target._id).lean()).comments).toHaveLength(0);

    const draftId = approvalPhrase.replace('Approve course chat draft ', '');
    fetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: '', tool_calls: [{ function: {
        name: 'publish_course_chat_draft',
        arguments: { draft_id: draftId },
      } }] } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: 'Approved response published.' } }), { status: 200 }));
    await authenticatedRequest(app, 'POST', `/api/v1/ai/courses/${course._id}/conversations/${conversationId}/messages`, {
      token,
      payload: { content: approvalPhrase },
    });

    await vi.waitFor(async () => {
      const post = await Post.findById(target._id).lean();
      expect(post.comments).toEqual([
        expect.objectContaining({ _id: draftId, body: 'The assignment is due Friday at 5 PM.', authorRole: 'instructor' }),
      ]);
      const updated = await authenticatedRequest(app, 'GET', `/api/v1/ai/courses/${course._id}/conversations/${conversationId}`, { token });
      expect(updated.json().conversation.messages.at(-1).content).toContain('Published the approved course chat response');
    });
  });

  it('halts an in-progress AI response summary and leaves it ready to regenerate', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const professor = await createTestUser({ email: 'ai-summary-halt-prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, professor);
    const course = await createCourse(token);
    await Course.findByIdAndUpdate(course._id, { $set: { aiEnabled: true } });
    await configureAi(course._id);
    const question = await Question.create({ type: 2, plainText: 'Explain recursion.', creator: professor._id, courseId: course._id });
    const session = await Session.create({
      name: 'Summary session',
      courseId: course._id,
      creator: professor._id,
      status: 'done',
      questions: [question._id],
      joined: [],
    });
    vi.stubGlobal('fetch', vi.fn((_, options) => new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    })));

    const started = await authenticatedRequest(
      app,
      'POST',
      `/api/v1/ai/courses/${course._id}/sessions/${session._id}/questions/${question._id}/ai-summary`,
      { token, payload: { instruction: 'Summarize the responses.' } }
    );
    expect(started.statusCode).toBe(202);
    await vi.waitFor(async () => {
      expect((await AiResponseSummary.findById(started.json().summary._id).lean()).phase).toBe('generating');
    });

    const halted = await authenticatedRequest(
      app,
      'POST',
      `/api/v1/ai/courses/${course._id}/sessions/${session._id}/questions/${question._id}/ai-summary/halt`,
      { token }
    );

    expect(halted.statusCode).toBe(200);
    expect(halted.json().summary).toMatchObject({ status: 'halted', phase: 'halted' });
    await vi.waitFor(() => expect(fetch.mock.calls[0][1].signal.aborted).toBe(true));
    const reloaded = await authenticatedRequest(
      app,
      'GET',
      `/api/v1/ai/courses/${course._id}/sessions/${session._id}/questions/${question._id}/ai-summary`,
      { token }
    );
    expect(reloaded.json().summary).toMatchObject({ status: 'halted', phase: 'halted' });
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

  it('returns the course grade table in bounded student and session pages', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const professor = await createTestUser({ email: 'course-table-prof@example.com', roles: ['professor'] });
    const ada = await createTestUser({ email: 'course-table-ada@example.com', firstname: 'Ada', lastname: 'Lovelace' });
    const grace = await createTestUser({ email: 'course-table-grace@example.com', firstname: 'Grace', lastname: 'Hopper' });
    const token = await getAuthToken(app, professor);
    const course = await createCourse(token);
    await Course.findByIdAndUpdate(course._id, { $addToSet: { students: { $each: [ada._id, grace._id] } } });
    const firstSession = await Session.create({ name: 'First', courseId: course._id, creator: professor._id, status: 'done', createdAt: new Date('2026-08-01') });
    const secondSession = await Session.create({ name: 'Second', courseId: course._id, creator: professor._id, status: 'done', createdAt: new Date('2026-08-02'), submittedQuiz: [ada._id] });
    await Grade.create([
      { userId: ada._id, courseId: course._id, sessionId: firstSession._id, value: 80, participation: 100, points: 4, outOf: 5, joined: true },
      { userId: ada._id, courseId: course._id, sessionId: secondSession._id, value: 90, participation: 50, points: 9, outOf: 10, joined: true },
      { userId: grace._id, courseId: course._id, sessionId: secondSession._id, value: 70, participation: 75, points: 7, outOf: 10, joined: true },
    ]);

    const result = await getCourseGradeTable(course._id, { studentLimit: 1, sessionLimit: 1 });

    expect(result).toMatchObject({ student_count: 2, session_count: 2, returned_student_count: 1, returned_session_count: 1, next_student_offset: 1, next_session_offset: 1 });
    expect(result.sessions[0]).toMatchObject({ name: 'Second' });
    expect(result.students[0]).toMatchObject({ student: { name: 'Ada Lovelace' }, average_participation: 75 });
    expect(result.students[0].session_grades[0]).toMatchObject({ grade_percentage: 90, participation_percentage: 50, submitted: true });
  });
});
