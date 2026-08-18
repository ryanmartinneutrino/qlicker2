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

  it('requests an immediate save when an API token field loses focus', () => {
    const onChange = vi.fn();
    const backends = [{ id: 'backend-1', url: 'http://ollama.test:11434', apiToken: 'secret', models: [] }];
    render(<AiBackendManager backends={backends} onChange={onChange} onDefaultChange={vi.fn()} />);

    fireEvent.blur(screen.getByLabelText('API token (optional)'));

    expect(onChange).toHaveBeenCalledWith(backends, { saveImmediately: true });
  });

  it('shows only approved course models initially and controls student access separately', () => {
    const onModelPoliciesChange = vi.fn();
    render(<AiBackendManager
      backends={[{
        id: 'backend-1',
        name: 'Shared backend',
        url: 'http://ollama.test:11434',
        models: [
          { id: 'model-1', name: 'Model 1', available: true },
          { id: 'model-2', name: 'Model 2', available: true },
        ],
      }]}
      courseId="course-1"
      readOnly
      canAddBackends={false}
      onChange={vi.fn()}
      defaultBackendId="backend-1"
      defaultModelId="model-1"
      modelPolicies={[{ backendId: 'backend-1', modelId: 'model-1', studentAvailable: false }]}
      onModelPoliciesChange={onModelPoliciesChange}
    />);

    expect(screen.getByRole('checkbox', { name: 'Model 1' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Model 2' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show available models' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Model 2' }));

    expect(onModelPoliciesChange).toHaveBeenCalledWith([
      { backendId: 'backend-1', modelId: 'model-1', studentAvailable: false },
      { backendId: 'backend-1', modelId: 'model-2', studentAvailable: false },
    ]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Model 1: Available to students' }));
    expect(onModelPoliciesChange).toHaveBeenLastCalledWith([
      { backendId: 'backend-1', modelId: 'model-1', studentAvailable: true },
    ]);
  });
});
