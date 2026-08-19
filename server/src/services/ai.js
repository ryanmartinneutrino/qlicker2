import { generateMeteorId } from '../utils/meteorId.js';

const AI_RESPONSE_FORMAT_ATTEMPTS = 2;

class AiResponseFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AiResponseFormatError';
  }
}

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

export async function discoverOpenAiModels(url, apiToken = '') {
  const endpoint = `${normalizeAiUrl(url)}/models`;
  const headers = {};
  if (String(apiToken || '').trim()) headers.authorization = `Bearer ${String(apiToken).trim()}`;
  let response;
  try {
    response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    const detail = error?.cause?.message || error?.message || 'connection failed';
    throw new Error(`Could not reach OpenAI-compatible model endpoint ${endpoint}: ${detail}. If Qlicker runs in Docker, localhost refers to the server container; use host.docker.internal to reach a service on the host.`);
  }
  if (!response.ok) {
    const detail = String(await response.text()).trim().replace(/\s+/g, ' ').slice(0, 300);
    throw new Error(`OpenAI-compatible model discovery failed at ${endpoint} (${response.status}${detail ? `: ${detail}` : ''})`);
  }
  const payload = await response.json();
  return (Array.isArray(payload?.data) ? payload.data : []).map((model) => ({
    id: String(model?.id || '').trim(),
    name: String(model?.name || model?.id || '').trim(),
  })).filter((model) => model.id && model.name);
}

export async function requestAiCompletion(backend, modelId, messages, signal = undefined) {
  const result = await requestAiMessage(backend, modelId, messages, [], signal);
  if (!result.content) throw new Error('AI backend returned an empty response');
  return result.content;
}

function parseToolArguments(value, toolName) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return {};
  if (typeof value !== 'string') throw new AiResponseFormatError(`AI backend returned non-object arguments for tool ${toolName}`);
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new AiResponseFormatError(`AI backend returned non-object arguments for tool ${toolName}`);
    }
    return parsed;
  }
  catch (error) {
    if (error instanceof AiResponseFormatError) throw error;
    throw new AiResponseFormatError(`AI backend returned invalid JSON arguments for tool ${toolName}`);
  }
}

function normalizeMessageContent(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value.map((part) => (part?.type === 'text' ? String(part.text || '') : '')).join('\n').trim();
  }
  throw new AiResponseFormatError('AI backend returned chat content in an unsupported format');
}

function normalizeToolCalls(toolCalls = []) {
  if (!Array.isArray(toolCalls)) throw new AiResponseFormatError('AI backend returned tool calls in an unsupported format');
  return (Array.isArray(toolCalls) ? toolCalls : []).map((call, index) => {
    const fn = call?.function || call || {};
    const name = String(fn.name || call?.name || '').trim();
    if (!name) throw new AiResponseFormatError('AI backend returned a tool call without a name');
    return {
      id: String(call?.id || `tool-call-${index}`),
      name,
      arguments: parseToolArguments(fn.arguments ?? call?.arguments, name),
    };
  });
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

async function requestAiMessageOnce(backend, modelId, messages, tools = [], signal = undefined) {
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
  let payload;
  try { payload = await response.json(); }
  catch { throw new AiResponseFormatError('AI backend returned invalid JSON'); }
  const message = isOpenAi ? payload?.choices?.[0]?.message : payload?.message;
  if (!message || typeof message !== 'object') throw new AiResponseFormatError('AI backend returned no chat message');
  const content = normalizeMessageContent(message.content);
  const toolCalls = normalizeToolCalls(message.tool_calls === undefined || message.tool_calls === null ? [] : message.tool_calls);
  if (!content && toolCalls.length === 0) throw new AiResponseFormatError('AI backend returned an empty response');
  return { content, toolCalls };
}

export async function requestAiMessage(backend, modelId, messages, tools = [], signal = undefined) {
  let formatError = null;
  for (let attempt = 0; attempt < AI_RESPONSE_FORMAT_ATTEMPTS; attempt += 1) {
    const correctiveMessage = attempt === 0 ? [] : [{
      role: 'system',
      content: 'Your previous response was rejected because its format was invalid. No tool call from that rejected response was executed. Continue from the existing conversation and tool results without repeating completed work. Return either a non-empty chat message or valid function tool calls whose arguments are strict JSON objects matching the supplied schemas.',
    }];
    try {
      return await requestAiMessageOnce(backend, modelId, [...messages, ...correctiveMessage], tools, signal);
    } catch (error) {
      if (!(error instanceof AiResponseFormatError)) throw error;
      formatError = error;
    }
  }
  throw new Error(`AI backend repeatedly returned an invalid response: ${formatError?.message || 'unknown format error'}`);
}
