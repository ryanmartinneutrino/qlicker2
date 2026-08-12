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
  default: ({ value, onChange, onKeyDown, placeholder }) => (
    <textarea
      aria-label="AI chat message"
      placeholder={placeholder}
      value={value}
      onChange={(event) => onChange({ html: `<p>${event.target.value}</p>`, plainText: event.target.value })}
      onKeyDown={onKeyDown}
    />
  ),
}));

describe('AiCourseChat', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    i18n.changeLanguage('en');
    apiClient.get.mockResolvedValue({ data: { conversations: [] } });
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
    fireEvent.change(screen.getByLabelText('AI chat message'), { target: { value: 'Can you help?' } });
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    fireEvent.keyDown(screen.getByLabelText('AI chat message'), { key: 'Enter', shiftKey: true });
    expect(apiClient.post).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText('AI chat message'), { key: 'Enter' });

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenLastCalledWith('/ai/courses/course-1/conversations/conversation-1/messages', {
        content: 'Can you help?',
        contentWysiwyg: '<p>Can you help?</p>',
      });
    });
    expect(await screen.findByText('course', { selector: 'strong' })).toBeInTheDocument();
    expect(document.querySelector('.katex')).not.toBeNull();
  });
});
