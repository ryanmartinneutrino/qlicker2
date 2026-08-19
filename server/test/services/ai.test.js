import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  discoverOllamaModels,
  discoverOpenAiModels,
  requestAiMessage,
} from '../../src/services/ai.js';

afterEach(() => vi.unstubAllGlobals());

describe('discoverOllamaModels', () => {
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: { content: '', tool_calls: [] } }), { status: 200 })
    ));

    await expect(requestAiMessage(
      { type: 'ollama', url: 'http://localhost:11434' },
      'local-model',
      [{ role: 'user', content: 'Create a question' }]
    )).rejects.toThrow('AI backend repeatedly returned an invalid response');
  });
});
