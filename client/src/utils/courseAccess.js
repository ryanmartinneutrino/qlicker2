export function isUserInstructorForCourse(course, userId) {
  const normalizedUserId = String(userId || '').trim();
  if (!course || !normalizedUserId) return false;
  return (course.instructors || []).some(
    (instructor) => String(instructor?._id || instructor || '').trim() === normalizedUserId
  );
}

export function shouldRedirectStudentCourseToInstructorView(course, user) {
  return isUserInstructorForCourse(course, user?._id);
}
