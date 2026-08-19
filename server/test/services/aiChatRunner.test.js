import { describe, expect, it } from 'vitest';
import {
  courseChatMaxToolRounds,
  DEFAULT_INSTRUCTOR_CHAT_MAX_TOOL_ROUNDS,
  DEFAULT_STUDENT_CHAT_MAX_TOOL_ROUNDS,
  recentConversationMessages,
} from '../../src/services/aiChatRunner.js';

describe('recentConversationMessages', () => {
  it('keeps the five most recent user prompts and their assistant responses', () => {
    const messages = Array.from({ length: 7 }, (_, index) => {
      const number = index + 1;
      return [
        { role: 'user', content: `Question ${number}` },
        { role: 'assistant', content: `Response ${number}` },
      ];
    }).flat();

    expect(recentConversationMessages(messages)).toEqual([
      { role: 'user', content: 'Question 3' },
      { role: 'assistant', content: 'Response 3' },
      { role: 'user', content: 'Question 4' },
      { role: 'assistant', content: 'Response 4' },
      { role: 'user', content: 'Question 5' },
      { role: 'assistant', content: 'Response 5' },
      { role: 'user', content: 'Question 6' },
      { role: 'assistant', content: 'Response 6' },
      { role: 'user', content: 'Question 7' },
      { role: 'assistant', content: 'Response 7' },
    ]);
  });
});

describe('course AI chat tool-round limits', () => {
  it('uses separate course settings for instructor and student chat', () => {
    const course = {
      aiInstructorChatMaxToolRounds: 27,
      aiStudentChatMaxToolRounds: 4,
    };

    expect(courseChatMaxToolRounds(course, 'instructor')).toBe(27);
    expect(courseChatMaxToolRounds(course, 'student')).toBe(4);
  });

  it('uses safe audience-specific defaults for missing or invalid values', () => {
    expect(courseChatMaxToolRounds({}, 'instructor')).toBe(DEFAULT_INSTRUCTOR_CHAT_MAX_TOOL_ROUNDS);
    expect(courseChatMaxToolRounds({}, 'student')).toBe(DEFAULT_STUDENT_CHAT_MAX_TOOL_ROUNDS);
    expect(courseChatMaxToolRounds({ aiInstructorChatMaxToolRounds: 100 }, 'instructor'))
      .toBe(DEFAULT_INSTRUCTOR_CHAT_MAX_TOOL_ROUNDS);
    expect(courseChatMaxToolRounds({ aiStudentChatMaxToolRounds: 0 }, 'student'))
      .toBe(DEFAULT_STUDENT_CHAT_MAX_TOOL_ROUNDS);
  });
});
