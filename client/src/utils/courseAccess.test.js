import { describe, expect, it } from 'vitest';
import {
  isUserInstructorForCourse,
  shouldRedirectStudentCourseToInstructorView,
} from './courseAccess';

describe('courseAccess', () => {
  it('detects when the current user is an instructor for a course', () => {
    expect(isUserInstructorForCourse({
      instructors: [{ _id: 'user-1' }],
    }, 'user-1')).toBe(true);
  });

  it('does not redirect professor student-view access when the user is not an instructor', () => {
    expect(shouldRedirectStudentCourseToInstructorView({
      instructors: [{ _id: 'different-user' }],
      students: ['prof-user'],
    }, {
      _id: 'prof-user',
      profile: { roles: ['professor'] },
    })).toBe(false);
  });

  it('does not redirect admin student-view access when the user is not an instructor', () => {
    expect(shouldRedirectStudentCourseToInstructorView({
      instructors: [{ _id: 'different-user' }],
      students: ['admin-user'],
    }, {
      _id: 'admin-user',
      profile: { roles: ['admin'] },
    })).toBe(false);
  });
});
