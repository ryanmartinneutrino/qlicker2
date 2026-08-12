export function hasIncompleteAiBackend(backends = []) {
  return backends.some((backend) => !String(backend?.url || '').trim());
}
