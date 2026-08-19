import { describe, expect, it } from 'vitest';
import { isCourseInstructorOrAdmin, isCourseMember, resolveCourseAiAudience } from '../../src/utils/courseAccess.js';

describe('course access', () => {
  const course = { instructors: ['course-professor'], students: ['student-professor'] };

  it('does not grant instructor privileges from the global professor role', () => {
    const user = { userId: 'student-professor', roles: ['professor', 'student'] };

    expect(isCourseInstructorOrAdmin(course, user)).toBe(false);
    expect(isCourseMember(course, user)).toBe(true);
    expect(resolveCourseAiAudience(course, user)).toBe('student');
  });

  it('grants instructor privileges only to an assigned instructor or an admin', () => {
    expect(isCourseInstructorOrAdmin(course, { userId: 'course-professor', roles: ['professor'] })).toBe(true);
    expect(isCourseInstructorOrAdmin(course, { userId: 'administrator', roles: ['admin'] })).toBe(true);
    expect(resolveCourseAiAudience(course, { userId: 'course-professor', roles: ['professor'] })).toBe('instructor');
    expect(resolveCourseAiAudience(course, { userId: 'student-professor', roles: ['admin'] })).toBe('instructor');
  });
});
