import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AiBackendManager from './AiBackendManager';
import i18n from '../../i18n';

describe('AiBackendManager', () => {
  it('hides backend creation when the course cannot configure custom backends', () => {
    i18n.changeLanguage('en');
    render(<AiBackendManager backends={[]} canAddBackends={false} onChange={vi.fn()} onDefaultChange={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Add backend' })).not.toBeInTheDocument();
  });

  it('updates a model availability and sends the selected default to its parent', () => {
    const onChange = vi.fn();
    const onDefaultChange = vi.fn();
    render(<AiBackendManager
      backends={[{
        id: 'backend-1', url: 'http://ollama.test:11434', models: [{ id: 'model-1', name: 'Model 1', available: true }],
      }]}
      onChange={onChange}
      onDefaultChange={onDefaultChange}
    />);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Model 1' }));
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({
      models: [expect.objectContaining({ id: 'model-1', available: false })],
    })]);

    fireEvent.click(screen.getByRole('button', { name: 'Make default' }));
    expect(onDefaultChange).toHaveBeenCalledWith('backend-1', 'model-1');
  });
});
