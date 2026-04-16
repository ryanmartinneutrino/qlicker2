import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CourseChatPanel from './CourseChatPanel';
import apiClient from '../../api/client';
import i18n from '../../i18n';

vi.mock('../../api/client', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../questions/StudentRichTextEditor', () => ({
  default: ({ value, onChange, placeholder, ariaLabel }) => (
    <textarea
      aria-label={ariaLabel}
      placeholder={placeholder}
      value={value}
      onChange={(event) => onChange({ html: event.target.value })}
    />
  ),
}));

vi.mock('../questions/richTextUtils', () => ({
  extractPlainTextFromHtml: (html = '') => String(html).replace(/<[^>]*>/g, '').trim(),
  prepareRichTextInput: (html = '', fallback = '') => html || fallback || '',
  renderKatexInElement: () => {},
}));

describe('CourseChatPanel', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    i18n.changeLanguage('en');
    apiClient.get.mockResolvedValue({
      data: {
        notificationId: '',
        canPost: true,
        canVote: true,
        canDeleteOwnPost: true,
        canDeleteAnyPost: false,
        canDeleteOwnComment: true,
        canDeleteAnyComment: false,
        canArchive: false,
        canViewNames: false,
        availableTags: [
          { value: 'homework', label: 'Homework' },
        ],
        posts: [],
      },
    });
    apiClient.post.mockResolvedValue({ data: { success: true } });
    apiClient.patch.mockResolvedValue({ data: { success: true } });
    apiClient.delete.mockResolvedValue({ data: { success: true } });
  });

  it('loads chat and submits a new post with topic and content', async () => {
    render(
      <CourseChatPanel
        courseId="course-1"
        enabled
        role="student"
        refreshToken={0}
      />
    );

    expect(await screen.findByText('No posts yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New post' }));
    fireEvent.change(screen.getByLabelText('Topic'), { target: { value: 'Midterm help' } });
    fireEvent.change(screen.getByLabelText('Course chat post editor'), { target: { value: '<p>Please review question 2</p>' } });
    fireEvent.click(screen.getByRole('button', { name: 'Publish post' }));

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith('/courses/course-1/chat/posts', {
        title: 'Midterm help',
        body: 'Please review question 2',
        bodyWysiwyg: '<p>Please review question 2</p>',
        tags: [],
      });
    });
  });

  it('shows original-poster labels and dismisses the chat notification when opened', async () => {
    apiClient.get.mockResolvedValueOnce({
      data: {
        notificationId: 'notification-1',
        canPost: true,
        canVote: true,
        canDeleteOwnPost: true,
        canDeleteAnyPost: false,
        canDeleteOwnComment: true,
        canDeleteAnyComment: false,
        canArchive: false,
        canViewNames: false,
        availableTags: [],
        posts: [
          {
            _id: 'post-1',
            title: 'Lab note',
            body: 'Main body',
            bodyWysiwyg: '<p>Main body</p>',
            createdAt: '2026-04-10T10:00:00.000Z',
            upvoteCount: 1,
            viewerHasUpvoted: false,
            isOwnPost: true,
            authorRole: 'student',
            comments: [
              {
                _id: 'comment-1',
                body: 'Follow-up',
                bodyWysiwyg: '<p>Follow-up</p>',
                createdAt: '2026-04-10T10:01:00.000Z',
                upvoteCount: 0,
                viewerHasUpvoted: false,
                isOwnComment: true,
                isOriginalPoster: true,
                authorRole: 'student',
              },
            ],
          },
        ],
      },
    });

    render(<CourseChatPanel courseId="course-1" enabled role="student" refreshToken={0} />);

    expect(await screen.findByText('Lab note')).toBeInTheDocument();
    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith('/notifications/notification-1/dismiss');
    });

    fireEvent.click(screen.getByRole('button', { name: '1 comment' }));
    expect(await screen.findByText('Original poster')).toBeInTheDocument();
  });
});
