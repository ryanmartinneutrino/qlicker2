import { expect, test } from '@playwright/test';
import {
  addInstructorToCourseViaApi, addQuestionToSessionViaApi, apiJson,
  createCourseViaApi, createQuestionViaApi, createSessionViaApi, enrollStudentViaApi,
  expectNoCriticalAccessibilityViolations, loginViaUi, patchSessionViaApi, patchSettingsViaApi, seedUsers,
} from './helpers.js';

test('course settings retain their tab and course searches start expanded', async ({ page, request, browser }) => {
  const { admin, professor, student } = await seedUsers(request);
  const course = await createCourseViaApi(request, admin.token);
  await addInstructorToCourseViaApi(request, admin.token, course._id, professor.user._id);
  await enrollStudentViaApi(request, student.token, course.enrollmentCode);
  const interactive = await createSessionViaApi(request, admin.token, course._id, { name: 'Searchable interactive' });
  await patchSessionViaApi(request, admin.token, interactive._id, { status: 'visible' });
  const quiz = await createSessionViaApi(request, admin.token, course._id, { name: 'Searchable quiz', quiz: true });
  await patchSessionViaApi(request, admin.token, quiz._id, { status: 'done' });
  await patchSettingsViaApi(request, admin.token, {
    AI_Enabled: true, AI_EnabledCourses: [course._id], Jitsi_Enabled: true, Jitsi_EnabledCourses: [course._id],
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await loginViaUi(page, professor.email, professor.password, /\/prof$/);
  await page.goto(`/prof/course/${course._id}`);
  await page.getByRole('tab', { name: /^Course Settings$/i }).click();
  await expect(page).toHaveURL(/tab=settings/);
  const settingsTab = page.getByRole('tab', { name: /^Course Settings$/i });
  for (const label of ['Enable AI helper', 'Enable course chat', 'Enable AI helper', 'Enable course chat']) {
    await page.getByLabel(label, { exact: true }).click();
    await expect(settingsTab).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(/tab=settings/);
    await page.reload();
    await expect(settingsTab).toHaveAttribute('aria-selected', 'true');
  }
  for (const name of [/^Interactive Sessions/, /^Quizzes/]) {
    await page.getByRole('tab', { name }).click();
    const search = page.getByPlaceholder('Search by session name');
    await expect(search).toBeVisible();
    await page.getByRole('button', { name: 'Search sessions', exact: true }).click();
    await expect(search).not.toBeVisible();
    await page.getByRole('button', { name: 'Search sessions', exact: true }).click();
    await expect(search).toBeVisible();
  }
  await page.getByRole('button', { name: /Searchable quiz/i }).first().click();
  await expect(page).toHaveURL(/returnTab=1/);
  await page.getByRole('button', { name: /back to course/i }).click();
  await expect(page.getByRole('tab', { name: /^Quizzes/ })).toHaveAttribute('aria-selected', 'true');
  await expectNoCriticalAccessibilityViolations(page);

  const studentContext = await browser.newContext();
  page = await studentContext.newPage();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await loginViaUi(page, student.email, student.password, /\/student$/);
  await page.goto(`/student/course/${course._id}`);
  for (const name of [/^Lectures/, /^Quizzes/]) {
    await page.getByRole('tab', { name }).click();
    const search = page.getByPlaceholder('Search by session name');
    await expect(search).toBeVisible();
    await page.getByRole('button', { name: 'Search sessions', exact: true }).click();
    await expect(search).not.toBeVisible();
    await page.getByRole('button', { name: 'Search sessions', exact: true }).click();
    await expect(search).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expectNoCriticalAccessibilityViolations(page);
  await studentContext.close();
});

test('an ended quiz stays ended for the professor while its extension student can answer', async ({ browser, request }) => {
  const { admin, professor, student } = await seedUsers(request);
  const course = await createCourseViaApi(request, admin.token);
  await addInstructorToCourseViaApi(request, admin.token, course._id, professor.user._id);
  await enrollStudentViaApi(request, student.token, course.enrollmentCode);
  const now = Date.now();
  const quiz = await createSessionViaApi(request, admin.token, course._id, {
    name: 'Ended with extension', quiz: true,
    quizStart: new Date(now - 7200000).toISOString(), quizEnd: new Date(now - 3600000).toISOString(),
  });
  const question = await createQuestionViaApi(request, admin.token, {
    sessionId: quiz._id, courseId: course._id, content: 'Extension question',
  });
  await addQuestionToSessionViaApi(request, admin.token, quiz._id, question._id);
  await patchSessionViaApi(request, admin.token, quiz._id, { status: 'done' });
  const extension = await apiJson(request, 'PATCH', `/sessions/${quiz._id}/extensions`, {
    token: professor.token,
    payload: { extensions: [{ userId: student.user._id, quizStart: new Date(now - 60000).toISOString(), quizEnd: new Date(now + 3600000).toISOString() }] },
  });
  expect(extension.response.status()).toBe(200);
  const professorContext = await browser.newContext();
  const studentContext = await browser.newContext();
  try {
    const profPage = await professorContext.newPage();
    await loginViaUi(profPage, professor.email, professor.password, /\/prof$/);
    await profPage.goto(`/prof/course/${course._id}?tab=1`);
    await expect(profPage.getByText('Extensions Active', { exact: true })).toBeVisible();
    await expect(profPage.getByRole('button', { name: /Ended with extension Ended/i })).toBeVisible();
    await expect(profPage.getByLabel('Reviewable', { exact: true })).toBeDisabled();
    await profPage.getByRole('button', { name: /Ended with extension/i }).first().click();
    await expect(profPage.getByRole('switch', { name: 'Toggle student review access', exact: true })).toBeDisabled();

    const studentPage = await studentContext.newPage();
    await loginViaUi(studentPage, student.email, student.password, /\/student$/);
    await studentPage.goto(`/student/course/${course._id}?tab=1`);
    await studentPage.getByRole('button', { name: /Ended with extension/i }).first().click();
    await expect(studentPage.getByText('Extension question', { exact: true })).toBeVisible();
    await studentPage.getByRole('radio', { name: /B\s*4/ }).check();
    await studentPage.getByRole('button', { name: /Submit quiz/i }).click();
    await expect(studentPage.getByText(/Quiz submitted/i).first()).toBeVisible();
  } finally {
    await professorContext.close();
    await studentContext.close();
  }
});
