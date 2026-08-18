import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverOllamaModels, discoverOpenAiModels } from '../../src/services/ai.js';

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
