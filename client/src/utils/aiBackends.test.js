import { describe, expect, it } from 'vitest';
import { getAvailableAiModels, hasIncompleteAiBackend } from './aiBackends';

describe('hasIncompleteAiBackend', () => {
  it('keeps a newly-added backend as a local draft until it has a URL', () => {
    expect(hasIncompleteAiBackend([{ id: 'new-backend', url: '' }])).toBe(true);
    expect(hasIncompleteAiBackend([{ id: 'configured-backend', url: 'http://localhost:11434' }])).toBe(false);
  });

  it('includes only enabled models in the course model choices', () => {
    expect(getAvailableAiModels([{
      id: 'backend-1',
      models: [{ id: 'available', available: true }, { id: 'disabled', available: false }],
    }])).toEqual([{
      backend: expect.objectContaining({ id: 'backend-1' }),
      model: expect.objectContaining({ id: 'available' }),
    }]);
  });
});
