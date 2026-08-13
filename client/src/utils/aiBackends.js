export function hasIncompleteAiBackend(backends = []) {
  return backends.some((backend) => !String(backend?.url || '').trim());
}

export function getAvailableAiModels(backends = []) {
  return backends.flatMap((backend) => (backend.models || [])
    .filter((model) => model.available !== false)
    .map((model) => ({ backend, model })));
}
