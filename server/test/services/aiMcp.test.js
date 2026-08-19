import { describe, expect, it } from 'vitest';
import { createCourseMcpClient } from '../../src/services/aiMcp.js';

describe('course AI MCP audience and history', () => {
  it('gives the student audience only the role-safe conversation history tool', async () => {
    const historyMessages = Array.from({ length: 7 }, (_, index) => ([
      { role: 'user', content: `Question ${index + 1}` },
      { role: 'assistant', content: `Answer ${index + 1}` },
    ])).flat();
    const mcp = await createCourseMcpClient({ courseId: 'course-1', audience: 'student', historyMessages });
    try {
      const tools = await mcp.client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(['get_conversation_history']);
      const result = await mcp.client.callTool({ name: 'get_conversation_history', arguments: { offset: 0, limit: 2 } });
      const payload = JSON.parse(result.content[0].text);
      expect(payload).toMatchObject({ total_turns: 7, supplied_recent_turns: 5, returned_count: 2, next_offset: 2 });
      expect(payload.turns[0].messages[0].content).toBe('Question 1');
    } finally {
      await mcp.close();
    }
  });

  it('registers authoring tools only for instructors', async () => {
    const mcp = await createCourseMcpClient({ courseId: 'course-1', userId: 'prof-1', audience: 'instructor' });
    try {
      const tools = await mcp.client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        'get_conversation_history',
        'create_course_session',
        'edit_course_session',
        'list_course_questions',
        'create_course_question',
        'edit_course_question',
      ]));
    } finally {
      await mcp.close();
    }
  });
});
