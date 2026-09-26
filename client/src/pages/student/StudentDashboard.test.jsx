import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import StudentDashboard from './StudentDashboard';

const { apiClientMock, authState, fetchAllCoursesMock, tMock } = vi.hoisted(() => ({
  apiClientMock: {
    get: vi.fn(),
    post: vi.fn(),
  },
  authState: {
    user: {
      profile: {
        roles: ['student'],
      },
      hasInstructorCourses: false,
    },
  },
  fetchAllCoursesMock: vi.fn(),
  tMock: vi.fn((key, options) => options?.defaultValue ?? key),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tMock }),
}));

vi.mock('../../api/client', () => ({
  default: apiClientMock,
  getAccessToken: vi.fn(() => null),
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => authState,
}));

vi.mock('../../utils/fetchAllCourses', () => ({
  fetchAllCourses: fetchAllCoursesMock,
}));

describe('StudentDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = {
      profile: {
        roles: ['student'],
      },
      hasInstructorCourses: false,
    };
    apiClientMock.get.mockImplementation((url) => {
      if (url === '/sessions/live') {
        return Promise.resolve({ data: { liveSessions: [] } });
      }
      if (url === '/health') {
        return Promise.resolve({ data: { websocket: false } });
      }
      return Promise.resolve({ data: {} });
    });
    fetchAllCoursesMock.mockResolvedValue([
      {
        _id: 'course-1',
        name: 'Course One',
        semester: 'Fall 2026',
      },
    ]);
  });

  function renderDashboard() {
    return render(
      <MemoryRouter>
        <StudentDashboard />
      </MemoryRouter>
    );
  }

  it('does not fetch instructor courses for student-only users', async () => {
    renderDashboard();

    await waitFor(() => {
      expect(fetchAllCoursesMock).toHaveBeenCalledTimes(1);
    });

    expect(fetchAllCoursesMock).toHaveBeenCalledWith(apiClientMock, { view: 'student' }, expect.objectContaining({ signal: expect.anything() }));
    expect(fetchAllCoursesMock).not.toHaveBeenCalledWith(apiClientMock, { view: 'instructor' }, expect.anything());
  });

  it('redeems activity codes from the existing code form without enrolling', async () => {
    apiClientMock.post.mockResolvedValue({ data: {
      sessionId: 'session-1', courseId: 'course-1', quiz: true,
    } });
    function Location() {
      const location = useLocation();
      return <span data-testid="location">{location.pathname}</span>;
    }
    render(
      <MemoryRouter initialEntries={['/student']}>
        <Routes>
          <Route path="/student" element={<StudentDashboard />} />
          <Route path="/activity/:courseId/session/:sessionId/quiz" element={<Location />} />
        </Routes>
      </MemoryRouter>
    );
    fireEvent.click(await screen.findByRole('button', { name: 'student.dashboard.enrollInCourse' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'student.dashboard.courseOrActivityCode' }), {
      target: { value: 's-' + 'A'.repeat(40) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'student.dashboard.continueWithCode' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/activity/course-1/session/session-1/quiz'));
    expect(apiClientMock.post).toHaveBeenCalledWith('/activity-codes/redeem', { code: 's-' + 'A'.repeat(40) });
    expect(apiClientMock.post).not.toHaveBeenCalledWith('/courses/enroll', expect.anything());
  });

  it('continues to enroll with ordinary course codes', async () => {
    apiClientMock.post.mockResolvedValue({ data: {} });
    renderDashboard();
    fireEvent.click(await screen.findByRole('button', { name: 'student.dashboard.enrollInCourse' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'student.dashboard.courseOrActivityCode' }), {
      target: { value: 'ABC123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'student.dashboard.continueWithCode' }));
    await waitFor(() => expect(apiClientMock.post).toHaveBeenCalledWith('/courses/enroll', { enrollmentCode: 'ABC123' }));
    expect(apiClientMock.post).not.toHaveBeenCalledWith('/activity-codes/redeem', expect.anything());
  });

  it('fetches instructor courses when the user has instructor-course access', async () => {
    authState.user = {
      profile: {
        roles: ['student'],
      },
      hasInstructorCourses: true,
    };
    fetchAllCoursesMock
      .mockResolvedValueOnce([
        {
          _id: 'course-1',
          name: 'Course One',
          semester: 'Fall 2026',
        },
      ])
      .mockResolvedValueOnce([
        {
          _id: 'course-2',
          name: 'TA Course',
          semester: 'Fall 2026',
        },
      ]);

    renderDashboard();

    await waitFor(() => {
      expect(fetchAllCoursesMock).toHaveBeenCalledTimes(2);
    });

    expect(fetchAllCoursesMock).toHaveBeenNthCalledWith(1, apiClientMock, { view: 'student' }, expect.objectContaining({ signal: expect.anything() }));
    expect(fetchAllCoursesMock).toHaveBeenNthCalledWith(2, apiClientMock, { view: 'instructor' }, expect.objectContaining({ signal: expect.anything() }));
  });
});
