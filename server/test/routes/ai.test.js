import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import Course from '../../src/models/Course.js';
import Settings from '../../src/models/Settings.js';
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
    expect(message.statusCode).toBe(200);
    expect(message.json().conversation.messages.map((entry) => entry.content)).toEqual(['Hello', 'Hello from Ollama']);
    expect(fetch).toHaveBeenCalledWith('http://ollama.test:11434/api/chat', expect.objectContaining({ method: 'POST' }));
  });
});
