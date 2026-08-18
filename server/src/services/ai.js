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

export async function discoverOllamaModels(url, apiToken = '') {
  const endpoint = `${normalizeAiUrl(url)}/api/tags`;
  const headers = {};
  if (String(apiToken || '').trim()) headers.authorization = `Bearer ${String(apiToken).trim()}`;
  let response;
  try {
    response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    const detail = error?.cause?.message || error?.message || 'connection failed';
    throw new Error(`Could not reach Ollama model endpoint ${endpoint}: ${detail}. If Qlicker runs in Docker, localhost refers to the server container; use host.docker.internal to reach a service on the host.`);
  }
  if (!response.ok) {
    const detail = String(await response.text()).trim().replace(/\s+/g, ' ').slice(0, 300);
    throw new Error(`Ollama model discovery failed at ${endpoint} (${response.status}${detail ? `: ${detail}` : ''})`);
  }
  const payload = await response.json();
  return (Array.isArray(payload?.models) ? payload.models : []).map((model) => ({ id: String(model?.name || '').trim(), name: String(model?.name || '').trim() })).filter((model) => model.id);
}

export async function requestAiCompletion(backend, modelId, messages) {
  const result = await requestAiMessage(backend, modelId, messages);
  if (!result.content) throw new Error('AI backend returned an empty response');
  return result.content;
}

function parseToolArguments(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try { return JSON.parse(value); }
  catch { return {}; }
}

function normalizeToolCalls(toolCalls = []) {
  return (Array.isArray(toolCalls) ? toolCalls : []).map((call, index) => {
    const fn = call?.function || call || {};
    const name = String(fn.name || call?.name || '').trim();
    if (!name) return null;
    return {
      id: String(call?.id || `tool-call-${index}`),
      name,
      arguments: parseToolArguments(fn.arguments ?? call?.arguments),
    };
  }).filter(Boolean);
}

function toolDefinitionsForProvider(tools = []) {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.inputSchema || { type: 'object', properties: {} },
    },
  }));
}

export async function requestAiMessage(backend, modelId, messages, tools = [], signal = undefined) {
  const headers = { 'content-type': 'application/json' };
  if (backend.apiToken) headers.authorization = `Bearer ${backend.apiToken}`;
  const baseUrl = normalizeAiUrl(backend.url);
  const isOpenAi = backend.type === 'openai';
  const requestBody = { model: modelId, messages, stream: false };
  if (tools.length > 0) requestBody.tools = toolDefinitionsForProvider(tools);
  const response = await fetch(isOpenAi ? `${baseUrl}/chat/completions` : `${baseUrl}/api/chat`, {
    method: 'POST', headers,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000),
    body: JSON.stringify(requestBody),
  });
  if (!response.ok) throw new Error(`AI backend request failed (${response.status})`);
  const payload = await response.json();
  const message = isOpenAi ? payload?.choices?.[0]?.message : payload?.message;
  const content = String(message?.content || '').trim();
  const toolCalls = normalizeToolCalls(message?.tool_calls);
  if (!content && toolCalls.length === 0) throw new Error('AI backend returned an empty response');
  return { content, toolCalls };
}
