import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { authenticatedRequest, createApp, createTestUser, getAuthToken } from '../helpers.js';
import Course from '../../src/models/Course.js';
import Post from '../../src/models/Post.js';

let app;

beforeEach(async (ctx) => {
  if (mongoose.connection.readyState !== 1) {
    ctx.skip();
    return;
  }
  app = await createApp();
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

async function createCourse(profToken, overrides = {}) {
  const res = await authenticatedRequest(app, 'POST', '/api/v1/courses', {
    token: profToken,
    payload: {
      name: 'Course Chat 101',
      deptCode: 'CHAT',
      courseNumber: '101',
      section: '001',
      semester: 'Fall 2026',
      tags: [{ value: 'homework', label: 'Homework' }],
      ...overrides,
    },
  });
  return res.json().course;
}

describe('course chat routes', () => {
  it('lets instructors enable course chat and set retention', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'chat-prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    const course = await createCourse(token);

    const res = await authenticatedRequest(app, 'PATCH', `/api/v1/courses/${course._id}`, {
      token,
      payload: { courseChatEnabled: true, courseChatRetentionDays: 30 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().course.courseChatEnabled).toBe(true);
    expect(res.json().course.courseChatRetentionDays).toBe(30);
  });

  it('keeps instructor identities anonymous to students in course chat payloads', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'chat-prof-2@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const course = await createCourse(profToken, { courseChatEnabled: true });

    const student = await createTestUser({ email: 'chat-student@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);

    await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });

    await Course.findByIdAndUpdate(course._id, {
      $set: { courseChatEnabled: true },
    });

    await Post.create({
      scopeType: 'course',
      courseId: String(course._id),
      authorId: String(prof._id),
      authorRole: 'instructor',
      title: 'Professor announcement',
      body: 'Remember to review chapter 3.',
      bodyWysiwyg: '<p>Remember to review chapter 3.</p>',
      tags: ['homework'],
      comments: [],
      upvoteUserIds: [],
      upvoteCount: 0,
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}/chat`, {
      token: studentToken,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().posts).toHaveLength(1);
    expect(res.json().posts[0].authorName).toBeNull();
    expect(res.json().posts[0].author).toBeUndefined();
    expect(res.json().posts[0].authorRole).toBe('instructor');
  });
});
