import { describe, expect, it } from 'vitest';
import { hasIncompleteAiBackend } from './aiBackends';

describe('hasIncompleteAiBackend', () => {
  it('keeps a newly-added backend as a local draft until it has a URL', () => {
    expect(hasIncompleteAiBackend([{ id: 'new-backend', url: '' }])).toBe(true);
    expect(hasIncompleteAiBackend([{ id: 'configured-backend', url: 'http://localhost:11434' }])).toBe(false);
  });
});
