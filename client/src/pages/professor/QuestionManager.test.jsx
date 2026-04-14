import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import QuestionManager from './QuestionManager';

const {
  apiClientMock,
  requestCloseMock,
  tMock,
  questionEditorPropsMock,
} = vi.hoisted(() => ({
  apiClientMock: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
  },
  requestCloseMock: vi.fn(),
  tMock: vi.fn((key, options) => options?.defaultValue ?? key),
  questionEditorPropsMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tMock }),
}));

vi.mock('../../api/client', () => ({
  default: apiClientMock,
  getAccessToken: vi.fn(() => null),
}));

vi.mock('../../components/questions/QuestionDisplay', () => ({
  default: ({ question }) => <div>{question?.plainText || question?.content || ''}</div>,
}));

vi.mock('../../components/questions/QuestionEditor', () => ({
  default: React.forwardRef(function MockQuestionEditor(props, ref) {
    React.useImperativeHandle(ref, () => ({
      requestClose: requestCloseMock,
    }));
    questionEditorPropsMock(props);
    return <div>Mock Question Editor</div>;
  }),
}));

const baseEntry = {
  fingerprint: 'fp-1',
  duplicateCount: 2,
  responseBackedCount: 1,
  sessionLinkedCount: 1,
  standaloneCount: 1,
  sourceQuestionId: 'q-session',
  editableQuestionId: 'q-safe',
  requiresDetachedCopy: false,
  lastEditedAt: '2026-04-13T15:00:00.000Z',
  question: {
    _id: 'q-session',
    type: 2,
    content: '<p>Question content</p>',
    plainText: 'Question content',
    solution: '<p>Solution content</p>',
    solution_plainText: 'Solution content',
    questionManager: {
      importFormat: 'latex',
      importFilename: 'questions.tex',
      importedAt: '2026-04-12T12:00:00.000Z',
    },
  },
  courses: [{ _id: 'course-1', label: 'CS 301 · 001' }],
  creators: [{ userId: 'prof-1', displayName: 'Prof One', email: 'prof1@example.com' }],
  owners: [{ userId: 'prof-1', displayName: 'Prof One', email: 'prof1@example.com' }],
  tags: [{ value: 'algebra', label: 'algebra', count: 1 }],
};

function createListResponse(entries = [baseEntry]) {
  return {
    data: {
      entries,
      total: entries.length,
      page: 1,
      limit: 20,
      filters: {
        tags: [{ value: 'algebra', label: 'algebra', count: 1 }],
        courses: [{ _id: 'course-1', label: 'CS 301 · 001', count: 1 }],
        creators: [{ userId: 'prof-1', displayName: 'Prof One', email: 'prof1@example.com', count: 1 }],
        owners: [{ userId: 'prof-1', displayName: 'Prof One', email: 'prof1@example.com', count: 1 }],
      },
    },
  };
}

describe('QuestionManager page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestCloseMock.mockReset();

    apiClientMock.get.mockImplementation((url) => {
      if (url === '/health') {
        return Promise.resolve({ data: { websocket: false } });
      }
      if (url === '/question-manager/questions') {
        return Promise.resolve(createListResponse());
      }
      return Promise.reject(new Error(`Unexpected GET ${url}`));
    });

    apiClientMock.post.mockImplementation((url) => {
      if (url === '/question-manager/questions/export-latex') {
        return Promise.resolve({
          data: {
            filename: 'question-manager-export.tex',
            content: '\\begin{questions}',
          },
        });
      }
      if (url === '/question-manager/questions/import-latex') {
        return Promise.resolve({
          data: {
            questions: [{ _id: 'q-imported' }],
            warnings: [],
          },
        });
      }
      if (url === '/question-manager/questions/q-session/editable-copy') {
        return Promise.resolve({
          data: {
            detached: true,
            question: {
              _id: 'q-detached',
              type: 2,
              content: '<p>Detached question</p>',
              plainText: 'Detached question',
              tags: [{ value: 'algebra', label: 'algebra' }],
              questionManager: { detachedFromQuestionId: 'q-session' },
            },
          },
        });
      }
      return Promise.reject(new Error(`Unexpected POST ${url}`));
    });
  });

  function renderPage() {
    return render(
      <MemoryRouter>
        <QuestionManager />
      </MemoryRouter>
    );
  }

  it('renders grouped question-manager entries with detail metadata', async () => {
    renderPage();

    expect((await screen.findAllByText('Question content')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('2 copies').length).toBeGreaterThan(0);
    expect(screen.getAllByText('1 copy has responses').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Courses: CS 301 · 001/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Creator: Prof One/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Owner: Prof One/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Open course workspace' })).toBeInTheDocument();
  });

  it('expands and collapses every visible question group from the list controls', async () => {
    apiClientMock.get.mockImplementation((url) => {
      if (url === '/health') {
        return Promise.resolve({ data: { websocket: false } });
      }
      if (url === '/question-manager/questions') {
        return Promise.resolve(createListResponse([
          baseEntry,
          {
            ...baseEntry,
            fingerprint: 'fp-2',
            sourceQuestionId: 'q-session-2',
            editableQuestionId: 'q-safe-2',
            question: {
              ...baseEntry.question,
              _id: 'q-session-2',
              content: '<p>Question content 2</p>',
              plainText: 'Question content 2',
            },
          },
        ]));
      }
      return Promise.reject(new Error(`Unexpected GET ${url}`));
    });

    renderPage();
    await screen.findAllByText(/Question content/);

    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));

    expect(document.querySelector('[data-question-manager-preview="fp-1"]')).toHaveAttribute('aria-expanded', 'true');
    expect(document.querySelector('[data-question-manager-preview="fp-2"]')).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));

    expect(document.querySelector('[data-question-manager-preview="fp-1"]')).toHaveAttribute('aria-expanded', 'false');
    expect(document.querySelector('[data-question-manager-preview="fp-2"]')).toHaveAttribute('aria-expanded', 'false');
  });

  it('expands a lower question group in place without moving the viewport away', async () => {
    apiClientMock.get.mockImplementation((url) => {
      if (url === '/health') {
        return Promise.resolve({ data: { websocket: false } });
      }
      if (url === '/question-manager/questions') {
        return Promise.resolve(createListResponse([
          baseEntry,
          {
            ...baseEntry,
            fingerprint: 'fp-2',
            sourceQuestionId: 'q-session-2',
            editableQuestionId: 'q-safe-2',
            question: {
              ...baseEntry.question,
              _id: 'q-session-2',
              content: '<p>Question content 2</p>',
              plainText: 'Question content 2',
            },
          },
        ]));
      }
      return Promise.reject(new Error(`Unexpected GET ${url}`));
    });

    const scrollToMock = vi.fn();
    const originalScrollTo = window.scrollTo;
    const scrollXDescriptor = Object.getOwnPropertyDescriptor(window, 'scrollX');
    const scrollYDescriptor = Object.getOwnPropertyDescriptor(window, 'scrollY');

    window.scrollTo = scrollToMock;
    Object.defineProperty(window, 'scrollX', { configurable: true, value: 0 });
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 400 });

    try {
      renderPage();
      await screen.findAllByText(/Question content/);

      const preview = document.querySelector('[data-question-manager-preview="fp-2"]');
      expect(preview).toBeTruthy();
      const card = preview.closest('.MuiCard-root');
      expect(card).toBeTruthy();

      let callCount = 0;
      card.getBoundingClientRect = vi.fn(() => ({
        top: callCount++ === 0 ? 320 : 220,
        left: 0,
        right: 400,
        bottom: 520,
        width: 400,
        height: 200,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }));

      fireEvent.click(preview);

      await waitFor(() => {
        expect(scrollToMock).toHaveBeenCalledWith({ left: 0, top: 300 });
      });

      expect(preview).toHaveAttribute('aria-expanded', 'true');
      expect(apiClientMock.get.mock.calls.filter(([url]) => url === '/question-manager/questions')).toHaveLength(1);
    } finally {
      window.scrollTo = originalScrollTo;
      if (scrollXDescriptor) {
        Object.defineProperty(window, 'scrollX', scrollXDescriptor);
      }
      if (scrollYDescriptor) {
        Object.defineProperty(window, 'scrollY', scrollYDescriptor);
      }
    }
  });

  it('turns the edit pencil into a close action for the active inline editor', async () => {
    renderPage();

    await screen.findAllByText('Question content');
    fireEvent.click(screen.getAllByRole('button', { name: 'common.edit' })[0]);

    await waitFor(() => {
      expect(apiClientMock.post).toHaveBeenCalledWith('/question-manager/questions/q-session/editable-copy');
    });

    expect(await screen.findByText('Mock Question Editor')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'professor.sessionEditor.closeEditor' }));

    await waitFor(() => {
      expect(requestCloseMock).toHaveBeenCalledTimes(1);
    });
  });

  it('creates an editable detached copy and opens the inline editor', async () => {
    apiClientMock.get.mockImplementation((url) => {
      if (url === '/health') {
        return Promise.resolve({ data: { websocket: false } });
      }
      if (url === '/question-manager/questions') {
        return Promise.resolve(createListResponse([
          {
            ...baseEntry,
            editableQuestionId: '',
            requiresDetachedCopy: true,
          },
        ]));
      }
      return Promise.reject(new Error(`Unexpected GET ${url}`));
    });

    renderPage();

    await screen.findAllByText('Question content');
    fireEvent.click(screen.getAllByRole('button', { name: 'Create editable copy' })[0]);

    await waitFor(() => {
      expect(apiClientMock.post).toHaveBeenCalledWith('/question-manager/questions/q-session/editable-copy');
    });

    expect(await screen.findByText('Mock Question Editor')).toBeInTheDocument();
    expect(questionEditorPropsMock).toHaveBeenCalledWith(expect.objectContaining({
      inline: true,
      showVisibilityControls: false,
      allowCustomTags: true,
    }));
  });

  it('uploads LaTeX with the ignore-points option through the import dialog', async () => {
    renderPage();

    await screen.findAllByText('Question content');
    fireEvent.click(screen.getByRole('button', { name: 'Import LaTeX' }));

    const dialog = await screen.findByRole('dialog');
    const fileInput = dialog.querySelector('input[type="file"]');
    const file = new File(['\\begin{questions}'], 'questions.tex', { type: 'text/x-tex' });

    fireEvent.change(fileInput, { target: { files: [file] } });
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Ignore question point values' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import questions' }));

    await waitFor(() => {
      expect(apiClientMock.post).toHaveBeenCalledWith(
        '/question-manager/questions/import-latex',
        expect.any(FormData),
        expect.objectContaining({
          headers: { 'Content-Type': 'multipart/form-data' },
        })
      );
    });

    const [, formData] = apiClientMock.post.mock.calls.find(([url]) => url === '/question-manager/questions/import-latex');
    expect(formData.get('file')).toBe(file);
    expect(formData.get('ignorePoints')).toBe('true');
  });
});
