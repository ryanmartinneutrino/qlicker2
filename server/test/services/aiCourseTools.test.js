import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import Course from '../../src/models/Course.js';
import Session from '../../src/models/Session.js';
import User from '../../src/models/User.js';
import { getSessionDetails } from '../../src/services/aiCourseTools.js';

describe('AI course session detail tool', () => {
  it('returns every session property and paginated participant identities', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const course = await Course.create({
      name: 'Mechanics', deptCode: 'PHYS', courseNumber: '123', section: '001', semester: 'Fall 2026',
      owner: 'prof-1', instructors: ['prof-1'], enrollmentCode: 'ABC123',
    });
    const students = await User.create([
      { _id: 'student-1', profile: { firstname: 'Ada', lastname: 'Lovelace' }, emails: [{ address: 'ada@example.com' }] },
      { _id: 'student-2', profile: { firstname: 'Emmy', lastname: 'Noether' }, emails: [{ address: 'emmy@example.com' }] },
      { _id: 'student-3', profile: { firstname: 'Srinivasa', lastname: 'Ramanujan' }, emails: [{ address: 'ramanujan@example.com' }] },
    ]);
    const session = await Session.create({
      name: 'Chapter 8 quiz',
      description: 'Complete session metadata',
      courseId: course._id,
      creator: 'prof-1',
      status: 'visible',
      quiz: true,
      quizStart: new Date('2026-08-28T13:00:00.000Z'),
      quizEnd: new Date('2026-08-28T14:00:00.000Z'),
      quizExtensions: [{ userId: students[2]._id, quizStart: new Date('2026-08-28T13:30:00.000Z'), quizEnd: new Date('2026-08-28T14:30:00.000Z') }],
      questions: ['question-1', 'question-2'],
      joined: [students[0]._id, students[1]._id],
      joinRecords: [{ userId: students[0]._id, joinedAt: new Date('2026-08-28T12:58:00.000Z'), joinedWithCode: true }],
      submittedQuiz: [students[1]._id],
      questionResponseCounts: { 'question-1': 2 },
      joinCodeEnabled: true,
      currentJoinCode: '2468',
      chatEnabled: true,
    });

    const firstPage = await getSessionDetails(course._id, session._id, { participantLimit: 2 });

    expect(firstPage.session).toMatchObject({
      _id: session._id,
      name: 'Chapter 8 quiz',
      quiz: true,
      quizStart: '2026-08-28T13:00:00.000Z',
      quizEnd: '2026-08-28T14:00:00.000Z',
      questions: ['question-1', 'question-2'],
      joinCodeEnabled: true,
      currentJoinCode: '2468',
      chatEnabled: true,
      questionResponseCounts: { 'question-1': 2 },
    });
    expect(firstPage).toMatchObject({
      joined_student_count: 2,
      submitted_quiz_student_count: 1,
      participant_count: 3,
      returned_participant_count: 2,
      next_participant_offset: 2,
    });
    expect(firstPage.participants).toEqual([
      expect.objectContaining({
        student: expect.objectContaining({ student_id: 'student-1', name: 'Ada Lovelace', email: 'ada@example.com' }),
        joined: true,
        joined_at: '2026-08-28T12:58:00.000Z',
        joined_with_code: true,
        submitted_quiz: false,
      }),
      expect.objectContaining({
        student: expect.objectContaining({ student_id: 'student-2', name: 'Emmy Noether' }),
        joined: true,
        submitted_quiz: true,
      }),
    ]);

    const secondPage = await getSessionDetails(course._id, session._id, { participantOffset: 2, participantLimit: 2 });
    expect(secondPage.next_participant_offset).toBeNull();
    expect(secondPage.participants).toEqual([
      expect.objectContaining({
        student: expect.objectContaining({ student_id: 'student-3', name: 'Srinivasa Ramanujan' }),
        joined: false,
        submitted_quiz: false,
        has_quiz_extension: true,
      }),
    ]);
  });
});
