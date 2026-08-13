function userId(user) {
  return String(user?.userId || user?._id || '');
}

function userRoles(user) {
  return user?.roles || user?.profile?.roles || [];
}

export function isCourseInstructorOrAdmin(course, user) {
  if (userRoles(user).includes('admin')) return true;
  const id = userId(user);
  return !!id && (course?.instructors || []).some((instructorId) => String(instructorId) === id);
}

export function isCourseStudent(course, user) {
  const id = userId(user);
  return !!id && (course?.students || []).some((studentId) => String(studentId) === id);
}

export function isCourseMember(course, user) {
  if (course?.inactive && !isCourseInstructorOrAdmin(course, user) && isCourseStudent(course, user)) return false;
  return isCourseInstructorOrAdmin(course, user) || isCourseStudent(course, user);
}
