import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SessionEditor from './SessionEditor';

const {
  navigateMock,
  requestCloseMock,
  apiClientMock,
  buildPrintableSessionHtmlMock,
  downloadPdfMock,
  downloadJsonMock,
  lastQuestionEditorProps,
  questionLibraryPanelPropsMock,
  submitSelectedQuestionsMock,
} = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  requestCloseMock: vi.fn(),
  apiClientMock: {
    get: vi.fn(),
    patch: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
  buildPrintableSessionHtmlMock: vi.fn(() => '<html><body>PDF</body></html>'),
  downloadPdfMock: vi.fn().mockResolvedValue(undefined),
  downloadJsonMock: vi.fn(),
  lastQuestionEditorProps: { current: null },
  questionLibraryPanelPropsMock: vi.fn(),
  submitSelectedQuestionsMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key) => key,
  }),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ courseId: 'course-1', sessionId: 'session-1' }),
    useNavigate: () => navigateMock,
    useLocation: () => ({ state: {} }),
    useSearchParams: () => [new URLSearchParams('returnTab=1')],
  };
});

vi.mock('../../api/client', () => ({
  default: apiClientMock,
}));

vi.mock('../../components/questions/QuestionEditor', () => ({
  default: function MockQuestionEditor({ ref, ...props }) {
    lastQuestionEditorProps.current = props;
    React.useImperativeHandle(ref, () => ({
      requestClose: requestCloseMock,
    }));
    return <div>Mock Question Editor</div>;
  },
}));

vi.mock('../../components/questions/QuestionDisplay', () => ({
  default: ({ question }) => <div>{question?.content || ''}</div>,
}));

vi.mock('../../components/questions/QuestionLibraryPanel', () => ({
  default: function MockQuestionLibraryPanel({ ref, ...props }) {
    React.useImperativeHandle(ref, () => ({
      submitSelectedQuestions: submitSelectedQuestionsMock,
    }));

    React.useEffect(() => {
      props.selectionAction?.onSelectionChange?.(['library-q1']);
    }, [props.selectionAction]);

    questionLibraryPanelPropsMock(props);
    return <div>Mock Question Library Panel</div>;
  },
}));

vi.mock('../../components/common/AutoSaveStatus', () => ({
  default: () => null,
}));

vi.mock('../../components/common/BackLinkButton', () => ({
  default: ({ label, onClick }) => <button type="button" onClick={onClick}>{label}</button>,
}));

vi.mock('../../components/common/DateTimePreferenceField', () => ({
  default: ({ label, value = '', onChange }) => (
    <input
      aria-label={label}
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));

vi.mock('../../components/common/SessionStatusChip', () => ({
  default: ({ status }) => <div>{status}</div>,
}));

vi.mock('../../utils/courseTitle', () => ({
  buildCourseTitle: () => 'CS 101',
}));

vi.mock('../../utils/sessionExport', () => ({
  buildSessionExportFilename: (sessionName, suffix, extension) => `${sessionName}-${suffix}.${extension}`,
  buildPrintableSessionHtml: buildPrintableSessionHtmlMock,
  downloadPdf: downloadPdfMock,
  downloadJson: downloadJsonMock,
}));

describe('SessionEditor inline close behavior', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    requestCloseMock.mockReset();
    apiClientMock.get.mockReset();
    apiClientMock.patch.mockReset();
    apiClientMock.post.mockReset();
    apiClientMock.delete.mockReset();
    buildPrintableSessionHtmlMock.mockClear();
    downloadPdfMock.mockClear();
    downloadJsonMock.mockReset();
    questionLibraryPanelPropsMock.mockReset();
    submitSelectedQuestionsMock.mockReset();

    apiClientMock.get.mockImplementation((url) => {
      if (url === '/sessions/session-1') {
        return Promise.resolve({
          data: {
            session: {
              _id: 'session-1',
              name: 'Draft Session',
              description: '',
              quiz: false,
              practiceQuiz: false,
              msScoringMethod: 'right-minus-wrong',
              reviewable: false,
              status: 'hidden',
              tags: [{ value: 'kinematics', label: 'kinematics' }],
              questions: ['q1'],
              quizExtensions: [],
            },
          },
        });
      }

      if (url === '/questions/q1') {
        return Promise.resolve({
          data: {
            question: {
              _id: 'q1',
              type: 2,
              content: 'Original content',
              plainText: 'Original content',
              options: [],
              sessionOptions: { points: 1 },
            },
          },
        });
      }

      if (url === '/sessions/session-1/results') {
        return Promise.resolve({ data: { studentResults: [] } });
      }

      if (url === '/settings/public') {
        return Promise.resolve({ data: { timeFormat: '24h' } });
      }

      if (url === '/courses/course-1') {
        return Promise.resolve({
          data: {
            course: {
              _id: 'course-1',
              name: 'Test Course',
              deptCode: 'CS',
              courseNumber: '101',
              section: '001',
              tags: [
                { value: 'kinematics', label: 'kinematics' },
                { value: 'vectors', label: 'vectors' },
              ],
              quizTimeFormat: 'inherit',
              students: [],
            },
          },
        });
      }

      return Promise.reject(new Error(`Unexpected GET ${url}`));
    });
  });

  it('routes outer close buttons through the question editor close handler', async () => {
    render(<SessionEditor />);

    fireEvent.click((await screen.findAllByRole('button', { name: 'common.edit' }))[0]);
    expect(screen.getByText('Mock Question Editor')).toBeInTheDocument();
    expect(lastQuestionEditorProps.current?.showVisibilityControls).toBe(false);
    expect(lastQuestionEditorProps.current?.showCourseTagSettingsHint).toBe(true);

    fireEvent.click(screen.getAllByRole('button', { name: 'professor.sessionEditor.closeEditor' })[0]);

    await waitFor(() => {
      expect(requestCloseMock).toHaveBeenCalledTimes(1);
    });
  });

  it('uses the date-based quiz status label and warns when changing a draft quiz to date-controlled status', async () => {
    const originalGet = apiClientMock.get.getMockImplementation();
    const quizStart = new Date(Date.now() - 60_000).toISOString();
    const quizEnd = new Date(Date.now() + 60_000).toISOString();
    apiClientMock.get.mockImplementation((url) => {
      if (url === '/sessions/session-1') {
        return Promise.resolve({
          data: {
            session: {
              _id: 'session-1',
              name: 'Scheduled Quiz',
              description: '',
              quiz: true,
              practiceQuiz: false,
              quizStart,
              quizEnd,
              msScoringMethod: 'right-minus-wrong',
              reviewable: false,
              status: 'hidden',
              tags: [],
              questions: ['q1'],
              quizExtensions: [],
            },
          },
        });
      }
      return originalGet(url);
    });
    apiClientMock.patch.mockResolvedValue({
      data: {
        session: {
          _id: 'session-1',
          name: 'Scheduled Quiz',
          description: '',
          quiz: true,
          practiceQuiz: false,
          quizStart,
          quizEnd,
          status: 'visible',
          tags: [],
          questions: ['q1'],
          quizExtensions: [],
        },
      },
    });

    render(<SessionEditor />);

    const [statusSelect] = await screen.findAllByRole('combobox');
    fireEvent.mouseDown(statusSelect);
    fireEvent.click(await screen.findByRole('option', { name: 'professor.sessionEditor.liveBasedOnDate' }));

    expect(await screen.findByText('professor.sessionEditor.scheduledQuizLiveWarning')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'professor.sessionEditor.makeQuizLive' }));

    await waitFor(() => {
      expect(apiClientMock.patch).toHaveBeenCalledWith('/sessions/session-1', { status: 'visible' });
      expect(screen.getByText('running')).toBeInTheDocument();
    });
  });

  it('creates a new session-authored question once and inserts it into the session order directly', async () => {
    apiClientMock.post.mockImplementation((url, payload) => {
      if (url === '/questions') {
        return Promise.resolve({
          data: {
            question: {
              _id: 'source-q2',
              type: 6,
              content: '<p>Slide draft</p>',
              plainText: 'Slide draft',
              options: [],
              sessionOptions: { points: 0 },
            },
          },
        });
      }

      return Promise.reject(new Error(`Unexpected POST ${url}`));
    });

    apiClientMock.patch.mockImplementation((url, payload) => {
      if (url === '/sessions/session-1/questions/order') {
        expect(payload).toEqual({ questions: ['q1', 'source-q2'] });
        return Promise.resolve({ data: { success: true } });
      }
      return Promise.reject(new Error(`Unexpected PATCH ${url}`));
    });

    render(<SessionEditor />);

    fireEvent.click((await screen.findAllByRole('button', { name: 'common.edit' }))[0]);

    let saved;
    await act(async () => {
      saved = await lastQuestionEditorProps.current.onAutoSave({
        type: 6,
        content: '<p>Slide draft</p>',
        plainText: 'Slide draft',
        sessionOptions: { points: 0 },
      }, null);
    });

    expect(saved._id).toBe('source-q2');
    expect(apiClientMock.patch).toHaveBeenCalledWith('/sessions/session-1/questions/order', {
      questions: ['q1', 'source-q2'],
    });
    expect(apiClientMock.post).toHaveBeenCalledTimes(1);
  });

  it('exports session JSON from the export dialog', async () => {
    const originalGet = apiClientMock.get.getMockImplementation();
    apiClientMock.get.mockImplementation((url) => {
      if (url === '/sessions/session-1/export') {
        return Promise.resolve({
          data: {
            version: 1,
            session: {
              name: 'Draft Session',
              questions: [],
            },
          },
        });
      }
      return originalGet(url);
    });

    render(<SessionEditor />);

    fireEvent.click(await screen.findByRole('button', { name: 'professor.sessionEditor.exportSession' }));
    fireEvent.click(screen.getByRole('button', { name: 'professor.sessionEditor.exportFormatJson' }));
    fireEvent.click(screen.getByRole('button', { name: 'professor.sessionEditor.exportJson' }));

    await waitFor(() => {
      expect(apiClientMock.get).toHaveBeenCalledWith('/sessions/session-1/export');
      expect(downloadJsonMock).toHaveBeenCalledWith(
        'Draft Session-export.json',
        expect.objectContaining({ version: 1 })
      );
    });
  });

  it('downloads a PDF export from the export dialog', async () => {
    render(<SessionEditor />);

    fireEvent.click(await screen.findByRole('button', { name: 'professor.sessionEditor.exportSession' }));
    fireEvent.click(screen.getByRole('button', { name: 'professor.sessionEditor.pdfQuestions' }));

    await waitFor(() => {
      expect(buildPrintableSessionHtmlMock).toHaveBeenCalledWith(expect.objectContaining({
        variant: 'questions',
      }));
      expect(downloadPdfMock).toHaveBeenCalledWith(
        'Draft Session-questions.pdf',
        '<html><body>PDF</body></html>'
      );
    });
  });

  it('imports a session JSON file into the current course', async () => {
    apiClientMock.post.mockResolvedValue({
      data: {
        session: {
          _id: 'imported-session-1',
        },
      },
    });

    render(<SessionEditor />);
    await screen.findByRole('button', { name: 'professor.sessionEditor.importSession' });

    const input = screen.getByTestId('session-import-input');
    const fileContents = JSON.stringify({
      version: 1,
      session: {
        name: 'Imported Session',
        questions: [],
      },
    });
    const file = new File([fileContents], 'session.json', { type: 'application/json' });
    file.text = vi.fn().mockResolvedValue(fileContents);

    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(await screen.findByTestId('confirm-session-import'));

    await waitFor(() => {
      expect(file.text).toHaveBeenCalled();
      expect(apiClientMock.post).toHaveBeenCalledWith('/courses/course-1/sessions/import', {
        version: 1,
        session: {
          name: 'Imported Session',
          questions: [],
        },
        importTags: ['Imported'],
      });
      expect(navigateMock).toHaveBeenCalledWith(
        '/prof/course/course-1/session/imported-session-1?returnTab=1',
        { state: { returnTab: 1, returnTo: undefined } }
      );
    });
  });

  it('applies session tags to every question in the session', async () => {
    const originalGet = apiClientMock.get.getMockImplementation();
    apiClientMock.get.mockImplementation((url) => {
      if (url === '/questions/q1') {
        return Promise.resolve({
          data: {
            question: {
              _id: 'q1',
              type: 2,
              content: 'Original content',
              plainText: 'Original content',
              options: [],
              tags: [
                { value: 'Kinematics', label: 'Kinematics' },
                { value: 'legacy', label: 'legacy' },
              ],
              sessionOptions: { points: 1 },
            },
          },
        });
      }
      return originalGet(url);
    });
    apiClientMock.patch.mockResolvedValue({
      data: {
        question: {
          _id: 'q1',
          type: 2,
          content: 'Original content',
          plainText: 'Original content',
          options: [],
          tags: [{ value: 'kinematics', label: 'kinematics' }],
          sessionOptions: { points: 1 },
        },
      },
    });

    render(<SessionEditor />);

    fireEvent.click(await screen.findByRole('button', { name: 'professor.sessionEditor.applyTagsToAllQuestions' }));

    await waitFor(() => {
      expect(apiClientMock.patch).toHaveBeenCalledWith('/questions/q1', {
        tags: [
          { value: 'Kinematics', label: 'Kinematics' },
          { value: 'legacy', label: 'legacy' },
        ],
      });
    });
  });

  it('sets every gradable question to zero points and warns when grades exist', async () => {
    apiClientMock.patch.mockImplementation((url, payload) => {
      if (url === '/sessions/session-1/questions/points') {
        expect(payload).toEqual({ points: 0 });
        return Promise.resolve({
          data: {
            points: 0,
            updatedCount: 1,
            updatedQuestionIds: ['q1'],
            gradingAffected: true,
          },
        });
      }
      return Promise.reject(new Error(`Unexpected PATCH ${url}`));
    });

    render(<SessionEditor />);

    fireEvent.change(await screen.findByRole('spinbutton', {
      name: 'professor.sessionEditor.pointsPerQuestion',
    }), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', {
      name: 'professor.sessionEditor.applyPointsToAllQuestions',
    }));

    await waitFor(() => {
      expect(apiClientMock.patch).toHaveBeenCalledWith('/sessions/session-1/questions/points', { points: 0 });
      expect(screen.getByText('professor.sessionEditor.pointsChangedRegradeWarning')).toBeInTheDocument();
    });
  });

  it('offers an Add to session action beside Cancel at the bottom of the library modal', async () => {
    submitSelectedQuestionsMock.mockResolvedValue(undefined);

    render(<SessionEditor />);

    const addQuestionButtons = await screen.findAllByRole('button', {
      name: 'professor.sessionEditor.addQuestionAtPositionAria',
    });
    fireEvent.click(addQuestionButtons[0]);
    fireEvent.click(screen.getByRole('button', { name: 'student.course.copyFromQuestionLibrary' }));

    expect(await screen.findByText('Mock Question Library Panel')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'common.cancel' })).toBeInTheDocument();

    const addToSessionButton = screen.getByRole('button', { name: 'questionLibrary.bulk.addToSession' });
    expect(addToSessionButton).toBeEnabled();
    fireEvent.click(addToSessionButton);

    await waitFor(() => {
      expect(submitSelectedQuestionsMock).toHaveBeenCalledTimes(1);
    });
    expect(questionLibraryPanelPropsMock).toHaveBeenCalledWith(expect.objectContaining({
      selectionAction: expect.objectContaining({
        hideImport: true,
        onSelectionChange: expect.any(Function),
      }),
    }));
  });
});
