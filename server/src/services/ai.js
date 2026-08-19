import { generateMeteorId } from '../utils/meteorId.js';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import config from '../config/index.js';

const AI_RESPONSE_FORMAT_ATTEMPTS = 2;
const MAX_TOOL_CALLS_PER_RESPONSE = 10;
const MAX_AI_CHAT_CONTENT_CHARS = 100_000;

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
  if (parsed.username || parsed.password) throw new Error('AI backend URLs cannot contain credentials');
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

function ipv4Kind(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return 'invalid';
  if (parts[0] === 0 || parts[0] >= 224) return 'blocked';
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return 'blocked';
  if (parts[0] === 169 && parts[1] === 254) return 'blocked';
  if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return 'blocked';
  if (parts[0] === 192 && parts[1] === 0 && parts[2] === 2) return 'blocked';
  if (parts[0] === 198 && [18, 19].includes(parts[1])) return 'blocked';
  if (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) return 'blocked';
  if (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) return 'blocked';
  if (parts[0] === 127) return 'private';
  if (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168)) return 'private';
  return 'public';
}

function addressKind(address) {
  if (isIP(address) === 4) return ipv4Kind(address);
  const normalized = String(address || '').toLowerCase();
  if (normalized === '::' || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb') || normalized.startsWith('ff')) return 'blocked';
  if (normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd')) return 'private';
  if (normalized.startsWith('::ffff:')) {
    const tail = normalized.slice(7);
    if (isIP(tail) === 4) return ipv4Kind(tail);
    const words = tail.split(':');
    if (words.length === 2 && words.every((word) => /^[0-9a-f]{1,4}$/.test(word))) {
      const high = Number.parseInt(words[0], 16);
      const low = Number.parseInt(words[1], 16);
      return ipv4Kind(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return 'blocked';
  }
  return 'public';
}

async function validateAiEndpoint(value) {
  const normalized = normalizeAiUrl(value);
  const parsed = new URL(normalized);
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (['169.254.169.254', 'metadata.google.internal', 'metadata'].includes(hostname)) {
    throw new Error('AI backend URL points to a prohibited metadata service');
  }
  const privateHostAllowed = (config.aiBackendAllowedPrivateHosts || []).includes(hostname);
  let addresses;
  if (isIP(hostname)) addresses = [{ address: hostname }];
  else {
    try { addresses = await lookup(hostname, { all: true, verbatim: true }); }
    catch { throw new Error(`AI backend hostname could not be resolved: ${hostname}`); }
  }
  if (!addresses.length) throw new Error(`AI backend hostname could not be resolved: ${hostname}`);
  addresses.forEach(({ address }) => {
    const kind = addressKind(address);
    if (kind === 'blocked') throw new Error('AI backend URL resolves to a prohibited network address');
    if (kind === 'private' && !privateHostAllowed) {
      throw new Error(`Private AI backend host ${hostname} is not allowed by the server configuration`);
    }
  });
  return normalized;
}

async function aiFetch(value, options = {}, redirectsRemaining = 3) {
  const normalized = await validateAiEndpoint(value);
  const response = await fetch(normalized, { ...options, redirect: 'manual' });
  if (![301, 302, 303, 307, 308].includes(response.status)) return response;
  if (redirectsRemaining <= 0) throw new Error('AI backend returned too many redirects');
  const location = response.headers.get('location');
  if (!location) throw new Error('AI backend returned a redirect without a location');
  const redirectedUrl = new URL(location, normalized).toString();
  const redirectedOptions = { ...options, headers: { ...(options.headers || {}) } };
  if (new URL(redirectedUrl).origin !== new URL(normalized).origin) delete redirectedOptions.headers.authorization;
  if (response.status === 303) {
    redirectedOptions.method = 'GET';
    delete redirectedOptions.body;
  }
  return aiFetch(redirectedUrl, redirectedOptions, redirectsRemaining - 1);
}

async function boundedResponseText(response, maximumBytes = 2_000_000) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error('AI backend response exceeded the allowed size');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function boundedJson(response) {
  const text = await boundedResponseText(response);
  try { return JSON.parse(text); }
  catch { throw new AiResponseFormatError('AI backend returned invalid JSON'); }
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
    response = await aiFetch(endpoint, { headers, signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    const detail = error?.cause?.message || error?.message || 'connection failed';
    throw new Error(`Could not reach Ollama model endpoint ${endpoint}: ${detail}. If Qlicker runs in Docker, localhost refers to the server container; use host.docker.internal to reach a service on the host.`);
  }
  if (!response.ok) {
    const detail = String(await boundedResponseText(response, 2_000)).trim().replace(/\s+/g, ' ').slice(0, 300);
    throw new Error(`Ollama model discovery failed at ${endpoint} (${response.status}${detail ? `: ${detail}` : ''})`);
  }
  const payload = await boundedJson(response);
  return (Array.isArray(payload?.models) ? payload.models : []).map((model) => ({ id: String(model?.name || '').trim(), name: String(model?.name || '').trim() })).filter((model) => model.id);
}

export async function discoverOpenAiModels(url, apiToken = '') {
  const endpoint = `${normalizeAiUrl(url)}/models`;
  const headers = {};
  if (String(apiToken || '').trim()) headers.authorization = `Bearer ${String(apiToken).trim()}`;
  let response;
  try {
    response = await aiFetch(endpoint, { headers, signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    const detail = error?.cause?.message || error?.message || 'connection failed';
    throw new Error(`Could not reach OpenAI-compatible model endpoint ${endpoint}: ${detail}. If Qlicker runs in Docker, localhost refers to the server container; use host.docker.internal to reach a service on the host.`);
  }
  if (!response.ok) {
    const detail = String(await boundedResponseText(response, 2_000)).trim().replace(/\s+/g, ' ').slice(0, 300);
    throw new Error(`OpenAI-compatible model discovery failed at ${endpoint} (${response.status}${detail ? `: ${detail}` : ''})`);
  }
  const payload = await boundedJson(response);
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
  let content;
  if (typeof value === 'string') content = value.trim();
  if (Array.isArray(value)) {
    content = value.map((part) => (part?.type === 'text' ? String(part.text || '') : '')).join('\n').trim();
  }
  if (content === undefined) throw new AiResponseFormatError('AI backend returned chat content in an unsupported format');
  if (content.length > MAX_AI_CHAT_CONTENT_CHARS) throw new AiResponseFormatError('AI backend returned chat content that exceeded the allowed size');
  return content;
}

function normalizeToolCalls(toolCalls = []) {
  if (!Array.isArray(toolCalls)) throw new AiResponseFormatError('AI backend returned tool calls in an unsupported format');
  if (toolCalls.length > MAX_TOOL_CALLS_PER_RESPONSE) throw new AiResponseFormatError(`AI backend returned more than ${MAX_TOOL_CALLS_PER_RESPONSE} tool calls at once`);
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
  const response = await aiFetch(isOpenAi ? `${baseUrl}/chat/completions` : `${baseUrl}/api/chat`, {
    method: 'POST', headers,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000),
    body: JSON.stringify(requestBody),
  });
  if (!response.ok) throw new Error(`AI backend request failed (${response.status})`);
  const payload = await boundedJson(response);
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
