import { expect, test } from '@playwright/test';
import {
  addInstructorToCourseViaApi,
  addQuestionToSessionViaApi,
  apiJson,
  createCourseViaApi,
  createQuestionViaApi,
  createSessionViaApi,
  loginViaUi,
  seedUsers,
} from './helpers.js';

const HUMAN_TYPING_DELAY_MS = 130;
const TYPING_OVERHEAD_BUDGET_MS = 2500;

async function typeAtHumanCadence(editor, text) {
  const startedAt = Date.now();
  await editor.pressSequentially(text, { delay: HUMAN_TYPING_DELAY_MS });
  const elapsedMs = Date.now() - startedAt;
  const expectedDelayMs = text.length * HUMAN_TYPING_DELAY_MS;

  // The delay intentionally falls just beyond the previous 120 ms debounce,
  // which caused a large parent rerender between ordinary keystrokes. Allow
  // ample browser/CI overhead while still catching a repeated visible stall.
  expect(elapsedMs).toBeLessThan(expectedDelayMs + TYPING_OVERHEAD_BUDGET_MS);
  await expect(editor).toContainText(text);
}

async function typeWithPauses(page, editor, parts) {
  let expected = '';
  for (const part of parts) {
    await editor.pressSequentially(part, { delay: 35 });
    expected += part;
    await page.waitForTimeout(220);
    await expect(editor).toContainText(expected);
  }
}

test('course and live-session chat stay responsive while typing', async ({ page, request }) => {
  const { admin, professor } = await seedUsers(request, { student: false });
  const course = await createCourseViaApi(request, admin.token, { courseChatEnabled: true });
  await addInstructorToCourseViaApi(request, admin.token, course._id, professor.user._id);

  const courseUpdate = await apiJson(request, 'PATCH', `/courses/${course._id}`, {
    token: admin.token,
    payload: { courseChatEnabled: true },
  });
  expect(courseUpdate.response.status(), JSON.stringify(courseUpdate.body)).toBe(200);

  const session = await createSessionViaApi(request, admin.token, course._id, {
    chatEnabled: true,
    richTextChatEnabled: true,
  });
  const question = await createQuestionViaApi(request, admin.token, {
    courseId: course._id,
    sessionId: session._id,
  });
  await addQuestionToSessionViaApi(request, admin.token, session._id, question._id);

  await loginViaUi(page, professor.email, professor.password, /\/prof$/);
  await page.goto(`/prof/course/${course._id}`);
  await page.getByRole('tab', { name: 'Course Chat' }).click();
  await page.getByRole('button', { name: 'New post' }).click();
  await page.getByLabel('Post topic').fill('Typing responsiveness');

  const courseEditor = page.getByRole('textbox', { name: 'Course chat post editor' });
  const courseMessage = 'Course chat remains smooth.';
  await typeAtHumanCadence(courseEditor, courseMessage);
  await typeWithPauses(page, courseEditor, [' Pauses', ' keep', ' every character.']);
  const fullCourseMessage = `${courseMessage} Pauses keep every character.`;
  await page.getByRole('button', { name: 'Publish post' }).click();
  await expect(page.getByText(fullCourseMessage)).toBeVisible();

  const startResult = await apiJson(request, 'POST', `/sessions/${session._id}/start`, {
    token: professor.token,
    payload: {},
  });
  expect(startResult.response.status(), JSON.stringify(startResult.body)).toBe(200);

  await page.goto(`/prof/course/${course._id}/session/${session._id}/live`);
  const sessionChatToggle = page.getByLabel('Enable session chat');
  if (!(await sessionChatToggle.isChecked())) {
    await sessionChatToggle.click();
  }
  await page.getByRole('tab', { name: 'Chat' }).click();

  const sessionEditor = page.getByRole('textbox', { name: 'Session chat post editor' });
  if (!(await sessionEditor.isVisible())) {
    await page.getByRole('button', { name: 'Write a post' }).click();
  }
  const sessionMessage = 'Session chat remains smooth.';
  await typeAtHumanCadence(sessionEditor, sessionMessage);
  await typeWithPauses(page, sessionEditor, [' Pauses', ' keep', ' every character.']);
  const fullSessionMessage = `${sessionMessage} Pauses keep every character.`;
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(page.getByText(fullSessionMessage)).toBeVisible();
});
