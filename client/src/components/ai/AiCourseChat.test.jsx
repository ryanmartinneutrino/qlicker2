import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AiCourseChat from './AiCourseChat';
import apiClient from '../../api/client';
import i18n from '../../i18n';

vi.mock('../../api/client', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../questions/StudentRichTextEditor', () => ({
  default: ({ value, onChange, onKeyDown, placeholder, disabled }) => (
    <textarea
      aria-label="AI chat message"
      placeholder={placeholder}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange({ html: `<p>${event.target.value}</p>`, plainText: event.target.value })}
      onKeyDown={onKeyDown}
    />
  ),
}));

describe('AiCourseChat', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    i18n.changeLanguage('en');
    apiClient.get.mockImplementation((url) => Promise.resolve(url.endsWith('/config') ? { data: {
      approvedModels: [{ backendId: 'backend-1', backendName: 'Backend 1', modelId: 'model-1', modelName: 'Model 1' }],
      defaultBackendId: 'backend-1',
      defaultModelId: 'model-1',
    } } : { data: { conversations: [] } }));
  });

  it('accepts the rich-text editor value and sends its plain text without crashing', async () => {
    const conversation = { _id: 'conversation-1', title: '', messages: [] };
    const updatedConversation = {
      ...conversation,
      messages: [
        { _id: 'message-1', role: 'user', content: 'Can you help?', createdAt: '2026-08-12T10:00:00.000Z' },
        { _id: 'message-2', role: 'assistant', content: 'Of **course**. The answer is $x^2$.', createdAt: '2026-08-12T10:00:01.000Z' },
      ],
    };
    apiClient.post
      .mockResolvedValueOnce({ data: { conversation } })
      .mockResolvedValueOnce({ data: { conversation: updatedConversation } });

    render(<AiCourseChat courseId="course-1" />);

    await screen.findByText('No conversations yet.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled());
    fireEvent.change(screen.getByLabelText('AI chat message'), { target: { value: 'Can you help?' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    fireEvent.keyDown(screen.getByLabelText('AI chat message'), { key: 'Enter', shiftKey: true });
    expect(apiClient.post).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText('AI chat message'), { key: 'Enter' });

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenLastCalledWith('/ai/courses/course-1/conversations/conversation-1/messages', {
        content: 'Can you help?',
        contentWysiwyg: '<p>Can you help?</p>',
        backendId: 'backend-1',
        modelId: 'model-1',
      });
    });
    expect(await screen.findByText('course', { selector: 'strong' })).toBeInTheDocument();
    expect(document.querySelector('.katex')).not.toBeNull();
  });

  it('restores the thinking state for a persisted pending conversation and can stop it', async () => {
    const pendingConversation = {
      _id: 'conversation-1',
      title: 'Pending question',
      pending: true,
      messages: [{ _id: 'message-1', role: 'user', content: 'Please wait' }],
    };
    const stoppedConversation = { ...pendingConversation, pending: false, pendingError: 'AI response stopped' };
    apiClient.get.mockImplementation((url) => {
      if (url.endsWith('/config')) return Promise.resolve({ data: {
        approvedModels: [{ backendId: 'backend-1', backendName: 'Backend 1', modelId: 'model-1', modelName: 'Model 1' }],
        defaultBackendId: 'backend-1',
        defaultModelId: 'model-1',
      } });
      if (url.endsWith('/conversations')) return Promise.resolve({ data: { conversations: [pendingConversation] } });
      return Promise.resolve({ data: { conversation: pendingConversation } });
    });
    apiClient.post.mockResolvedValueOnce({ data: { conversation: stoppedConversation } });

    render(<AiCourseChat courseId="course-1" />);

    expect(await screen.findByText('Thinking…')).toBeInTheDocument();
    expect(screen.getByLabelText('AI chat message')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith('/ai/courses/course-1/conversations/conversation-1/stop');
    });
    expect(await screen.findByText('AI response stopped')).toBeInTheDocument();
  });

  it('clears a stale backend error when reloading a conversation', async () => {
    const failedConversation = {
      _id: 'conversation-1',
      title: 'Failed question',
      pending: false,
      pendingError: 'AI backend returned an empty response',
      messages: [{ _id: 'message-1', role: 'user', content: 'Please create a session' }],
    };
    const clearedConversation = { ...failedConversation, pendingError: '' };
    apiClient.get.mockImplementation((url) => {
      if (url.endsWith('/config')) return Promise.resolve({ data: {
        approvedModels: [{ backendId: 'backend-1', backendName: 'Backend 1', modelId: 'model-1', modelName: 'Model 1' }],
        defaultBackendId: 'backend-1',
        defaultModelId: 'model-1',
      } });
      return Promise.resolve({ data: { conversations: [failedConversation] } });
    });
    apiClient.delete.mockResolvedValueOnce({ data: { conversation: clearedConversation } });

    render(<AiCourseChat courseId="course-1" />);

    await waitFor(() => {
      expect(apiClient.delete).toHaveBeenCalledWith('/ai/courses/course-1/conversations/conversation-1/pending-error');
    });
    expect(screen.queryByText('AI backend returned an empty response')).not.toBeInTheDocument();
    expect(await screen.findByText('Please create a session')).toBeInTheDocument();
  });

  it('renders persisted backend failures as warning messages', async () => {
    const failedConversation = {
      _id: 'conversation-1',
      title: 'Timed out question',
      pending: false,
      pendingError: '',
      messages: [
        { _id: 'message-1', role: 'user', content: 'Please help' },
        { _id: 'message-2', role: 'assistant', content: 'AI backend ran into an error: request timed out', isError: true },
      ],
    };
    apiClient.get.mockImplementation((url) => {
      if (url.endsWith('/config')) return Promise.resolve({ data: {
        approvedModels: [{ backendId: 'backend-1', backendName: 'Backend 1', modelId: 'model-1', modelName: 'Model 1' }],
        defaultBackendId: 'backend-1',
        defaultModelId: 'model-1',
      } });
      if (url.endsWith('/conversations')) return Promise.resolve({ data: { conversations: [failedConversation] } });
      return Promise.resolve({ data: { conversation: failedConversation } });
    });

    render(<AiCourseChat courseId="course-1" />);

    const warning = await screen.findByRole('alert');
    expect(warning).toHaveTextContent('AI error');
    expect(warning).toHaveTextContent('The AI backend ran into an error: request timed out');
    expect(warning).toHaveStyle({ borderColor: '#ed6c02' });
  });

  it('uses the student endpoints and shows student-facing guidance', async () => {
    const conversation = { _id: 'student-conversation-1', title: '', messages: [] };
    apiClient.post.mockResolvedValueOnce({ data: { conversation } });

    render(<AiCourseChat courseId="course-1" audience="student" />);

    await screen.findByText('No conversations yet.');
    expect(apiClient.get).toHaveBeenCalledWith('/ai/student/courses/course-1/config');
    expect(apiClient.get).toHaveBeenCalledWith('/ai/student/courses/course-1/conversations');
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));

    expect(await screen.findByText(/Ask about this course or its content/)).toBeInTheDocument();
    expect(apiClient.post).toHaveBeenCalledWith('/ai/student/courses/course-1/conversations');
  });
});
