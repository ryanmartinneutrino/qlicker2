import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AiBackendManager from './AiBackendManager';
import i18n from '../../i18n';

describe('AiBackendManager', () => {
  it('hides backend creation when the course cannot configure custom backends', () => {
    i18n.changeLanguage('en');
    render(<AiBackendManager backends={[]} canAddBackends={false} onChange={vi.fn()} onDefaultChange={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Add backend' })).not.toBeInTheDocument();
  });
});
