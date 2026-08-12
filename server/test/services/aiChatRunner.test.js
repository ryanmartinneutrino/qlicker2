import { describe, expect, it } from 'vitest';
import { recentConversationMessages } from '../../src/services/aiChatRunner.js';

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
