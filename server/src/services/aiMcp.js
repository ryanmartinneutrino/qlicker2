import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  getQuestionResponses,
  getSessionGradeTable,
  getSessionQuestions,
  listCourseSessions,
  listCourseStudents,
} from './aiCourseTools.js';

function toolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function toolError(error) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: error.message || 'Tool request failed' }) }], isError: true };
}

export async function createCourseMcpClient({ courseId, audience = 'instructor' }) {
  const server = new McpServer({ name: 'qlicker-course-tools', version: '1.0.0' });

  // Student chat can use this same MCP boundary later with a smaller, separately
  // approved tool set. Do not accidentally grant instructor data to that audience.
  if (audience !== 'instructor') {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'qlicker-ai-runner', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return {
      client,
      async close() {
        await client.close();
        await server.close();
      },
    };
  }

  server.registerTool('list_course_students', {
    title: 'List course students',
    description: 'List students enrolled in the current course, including their names and email addresses. The course is fixed by the current chat context.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    try { return toolResult(await listCourseStudents(courseId)); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('list_course_sessions', {
    title: 'List course sessions',
    description: 'List non-student-created sessions in the current course. Use this to find a session ID before asking about its questions or responses.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    try { return toolResult(await listCourseSessions(courseId)); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('get_session_questions', {
    title: 'Get session questions',
    description: 'Get the ordered questions for a session in the current course. Session IDs must come from list_course_sessions.',
    inputSchema: { session_id: z.string().min(1) },
    annotations: { readOnlyHint: true },
  }, async ({ session_id: sessionId }) => {
    try { return toolResult(await getSessionQuestions(courseId, sessionId)); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('get_question_responses', {
    title: 'Get final-attempt question responses',
    description: 'Get student responses to a question in a session in the current course. It returns only responses from the highest attempt number that contains responses, matching grading. Results are paginated; use next_offset to request another page and state any limitation if content_truncated is true.',
    inputSchema: { session_id: z.string().min(1), question_id: z.string().min(1), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() },
    annotations: { readOnlyHint: true },
  }, async ({ session_id: sessionId, question_id: questionId, offset, limit }) => {
    try { return toolResult(await getQuestionResponses(courseId, sessionId, questionId, { offset, limit })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('get_session_grade_table', {
    title: 'Get detailed session grades',
    description: 'Get an instructor-only, paginated grade table for a session in the current course. Each student row contains the points earned and possible for every ordered question, plus totals. question_summaries contains aggregate score data for every question and is the preferred source for identifying questions students struggled with. Use sort_by total_points with a small limit for top performers. Use next_offset for more rows; the tool limits page size to preserve model context.',
    inputSchema: {
      session_id: z.string().min(1),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      sort_by: z.enum(['name', 'total_points', 'total_percentage']).optional(),
      order: z.enum(['asc', 'desc']).optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ session_id: sessionId, offset, limit, sort_by: sortBy, order }) => {
    try { return toolResult(await getSessionGradeTable(courseId, sessionId, { offset, limit, sortBy, order })); }
    catch (error) { return toolError(error); }
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'qlicker-ai-runner', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}
