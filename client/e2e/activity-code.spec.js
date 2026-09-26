import { expect, test } from '@playwright/test';
import {
  addInstructorToCourseViaApi, addQuestionToSessionViaApi, apiJson,
  createCourseViaApi, createQuestionViaApi, createSessionViaApi, loginViaUi,
  patchSessionViaApi, seedUsers,
} from './helpers.js';

test('course opt-in and session switch expose a persistent code for an outside quiz', async ({ page, browser, request }) => {
  const { admin, professor, student } = await seedUsers(request);
  const course = await createCourseViaApi(request, admin.token);
  await addInstructorToCourseViaApi(request, admin.token, course._id, professor.user._id);
  const quiz = await createSessionViaApi(request, admin.token, course._id, {
    name: 'Outside quiz', quiz: true,
    quizStart: new Date(Date.now() - 60_000).toISOString(),
    quizEnd: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const question = await createQuestionViaApi(request, admin.token, {
    sessionId: quiz._id, courseId: course._id, content: 'Outside quiz question',
  });
  await addQuestionToSessionViaApi(request, admin.token, quiz._id, question._id);
  await patchSessionViaApi(request, admin.token, quiz._id, { status: 'visible' });

  await loginViaUi(page, professor.email, professor.password, /\/prof$/);
  await page.goto(`/prof/course/${course._id}/session/${quiz._id}`);
  const sharing = page.getByLabel('Allow access by activity code');
  await expect(sharing).toBeDisabled();
  await page.goto(`/prof/course/${course._id}`);
  await page.getByRole('tab', { name: /^Course Settings$/i }).click();
  await page.getByLabel('Allow activities to be shared by code').click();
  await expect(page.getByLabel('Allow activities to be shared by code')).toBeChecked();

  await page.goto(`/prof/course/${course._id}/session/${quiz._id}`);
  await expect(sharing).toBeEnabled();
  await sharing.click();
  await expect(sharing).toBeChecked();
  const codeField = page.getByRole('textbox', { name: 'Activity code' });
  await expect(codeField).toHaveValue(/^S-[A-HJ-NP-Z2-9]{10}$/);
  const code = await codeField.inputValue();
  await page.reload();
  await expect(sharing).toBeChecked();
  await expect(codeField).toHaveValue(code);
  await expect(page.getByRole('button', { name: 'Regenerate code' })).toBeVisible();

  const studentContext = await browser.newContext();
  try {
    const studentPage = await studentContext.newPage();
    await loginViaUi(studentPage, student.email, student.password, /\/student$/);
    await studentPage.getByRole('button', { name: 'Enroll in Course' }).first().click();
    await studentPage.getByRole('textbox', { name: 'Course or activity code' }).fill(code);
    await studentPage.getByRole('button', { name: 'Continue' }).click();
    await expect(studentPage).toHaveURL(new RegExp(`/activity/${course._id}/session/${quiz._id}/quiz`));
    await expect(studentPage.getByText('Outside quiz question')).toBeVisible();

    await sharing.click();
    await expect(sharing).not.toBeChecked();
    await expect(codeField).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Regenerate code' })).toHaveCount(0);
    const denied = await apiJson(request, 'GET', `/sessions/${quiz._id}/quiz`, { token: student.token });
    expect(denied.response.status()).toBe(403);
  } finally {
    await studentContext.close();
  }
});
