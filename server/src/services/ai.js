import { generateMeteorId } from '../utils/meteorId.js';

export function normalizeAiUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  const parsed = new URL(raw);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('AI backend URL must use HTTP or HTTPS');
  return raw;
}

export function normalizeAiBackends(value = []) {
  if (!Array.isArray(value)) return [];
  return value.map((backend) => ({
    id: String(backend?.id || generateMeteorId()),
    name: String(backend?.name || '').trim(),
    type: backend?.type === 'openai' ? 'openai' : 'ollama',
    url: normalizeAiUrl(backend?.url),
    apiToken: String(backend?.apiToken || '').trim(),
    models: (Array.isArray(backend?.models) ? backend.models : []).map((model) => ({
      id: String(model?.id || model?.name || '').trim(),
      name: String(model?.name || model?.id || '').trim(),
      available: model?.available !== false,
    })).filter((model) => model.id && model.name),
  })).filter((backend) => backend.url && backend.id);
}

export function serializeAiBackends(backends = []) {
  return normalizeAiBackends(backends).map((backend) => ({ ...backend, apiToken: '', apiTokenSet: !!backend.apiToken }));
}

export async function discoverOllamaModels(url) {
  const response = await fetch(`${normalizeAiUrl(url)}/api/tags`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Ollama model discovery failed (${response.status})`);
  const payload = await response.json();
  return (Array.isArray(payload?.models) ? payload.models : []).map((model) => ({ id: String(model?.name || '').trim(), name: String(model?.name || '').trim() })).filter((model) => model.id);
}

export async function requestAiCompletion(backend, modelId, messages) {
  const headers = { 'content-type': 'application/json' };
  if (backend.apiToken) headers.authorization = `Bearer ${backend.apiToken}`;
  const baseUrl = normalizeAiUrl(backend.url);
  const isOpenAi = backend.type === 'openai';
  const response = await fetch(isOpenAi ? `${baseUrl}/chat/completions` : `${baseUrl}/api/chat`, {
    method: 'POST', headers, signal: AbortSignal.timeout(90_000),
    body: JSON.stringify({ model: modelId, messages, stream: false }),
  });
  if (!response.ok) throw new Error(`AI backend request failed (${response.status})`);
  const payload = await response.json();
  const content = isOpenAi ? payload?.choices?.[0]?.message?.content : payload?.message?.content;
  if (!String(content || '').trim()) throw new Error('AI backend returned an empty response');
  return String(content);
}
