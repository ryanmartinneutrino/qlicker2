import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  discoverOllamaModels,
  discoverOpenAiModels,
  normalizeAiRequestTimeoutSeconds,
  requestAiMessage,
} from '../../src/services/ai.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('discoverOllamaModels', () => {
  it('rejects cloud metadata and prohibited network targets while allowing configured private backends', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(discoverOllamaModels('http://169.254.169.254/latest'))
      .rejects.toThrow('prohibited metadata service');
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ models: [] }), { status: 200 })));
    await expect(discoverOllamaModels('http://10.20.30.40:11434')).resolves.toEqual([]);
    await expect(discoverOllamaModels('http://100.100.100.200/latest'))
      .rejects.toThrow('prohibited network address');
    await expect(discoverOllamaModels('http://[::ffff:7f00:1]:11434')).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('preserves a base path and forwards a bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      models: [{ name: 'local-model' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(discoverOllamaModels('http://localhost:8000/ollama/', 'secret-token'))
      .resolves.toEqual([{ id: 'local-model', name: 'local-model' }]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/ollama/api/tags',
      expect.objectContaining({ headers: { authorization: 'Bearer secret-token' } })
    );
  });

  it('includes the endpoint and upstream response in discovery errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('missing token', { status: 401 })));

    await expect(discoverOllamaModels('http://localhost:8000/ollama'))
      .rejects.toThrow('http://localhost:8000/ollama/api/tags (401: missing token)');
  });
});

describe('discoverOpenAiModels', () => {
  it('preserves a base path and forwards a bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'gpt-compatible-model' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(discoverOpenAiModels('http://localhost:8000/v1/', 'secret-token'))
      .resolves.toEqual([{ id: 'gpt-compatible-model', name: 'gpt-compatible-model' }]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/v1/models',
      expect.objectContaining({ headers: { authorization: 'Bearer secret-token' } })
    );
  });
});

describe('requestAiMessage', () => {
  it('normalizes administrator request timeouts to the supported range', () => {
    expect(normalizeAiRequestTimeoutSeconds(420)).toBe(420);
    expect(normalizeAiRequestTimeoutSeconds(1)).toBe(10);
    expect(normalizeAiRequestTimeoutSeconds(10_000)).toBe(1_800);
  });

  it('uses the request timeout attached to the selected backend', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: { content: 'Done' } }), { status: 200 })));

    await requestAiMessage(
      { type: 'ollama', url: 'http://localhost:11434', requestTimeoutMs: 420_000 },
      'local-model',
      [{ role: 'user', content: 'Hello' }]
    );

    expect(timeoutSpy).toHaveBeenCalledWith(420_000);
    timeoutSpy.mockRestore();
  });

  it('retries an empty model response with corrective format guidance', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: '' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: 'Recovered response' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestAiMessage(
      { type: 'ollama', url: 'http://localhost:11434' },
      'local-model',
      [{ role: 'user', content: 'Create a question' }],
      [{ name: 'create_course_question', inputSchema: { type: 'object', properties: {} } }]
    )).resolves.toEqual({ content: 'Recovered response', toolCalls: [] });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(retryBody.messages.at(-1)).toMatchObject({
      role: 'system',
      content: expect.stringContaining('strict JSON objects'),
    });
  });

  it('retries malformed string arguments instead of executing an empty tool request', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        message: { content: '', tool_calls: [{ function: { name: 'create_course_question', arguments: '{bad json' } }] },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        message: { content: '', tool_calls: [{ function: { name: 'create_course_question', arguments: { prompt: 'Valid' } } }] },
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await requestAiMessage(
      { type: 'ollama', url: 'http://localhost:11434' },
      'local-model',
      [{ role: 'user', content: 'Create a question' }],
      [{ name: 'create_course_question', inputSchema: { type: 'object', properties: {} } }]
    );

    expect(result.toolCalls).toEqual([expect.objectContaining({
      name: 'create_course_question',
      arguments: { prompt: 'Valid' },
    })]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails cleanly after two invalid model responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => (
      new Response(JSON.stringify({ message: { content: '', tool_calls: [] } }), { status: 200 })
    )));

    await expect(requestAiMessage(
      { type: 'ollama', url: 'http://localhost:11434' },
      'local-model',
      [{ role: 'user', content: 'Create a question' }]
    )).rejects.toThrow('AI backend repeatedly returned an invalid response');
  });
});
