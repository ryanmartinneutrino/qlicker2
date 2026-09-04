import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  addInstructorToCourseViaApi,
  addQuestionToSessionViaApi,
  apiJson,
  createCourseViaApi,
  createQuestionViaApi,
  createSessionViaApi,
  enrollStudentViaApi,
  loginViaUi,
  patchSessionViaApi,
  seedUsers,
} from './helpers.js';

const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '../..');
const docsOutputDir = path.join(repoRoot, 'docs/assets/manuals');
const publicOutputDir = path.join(repoRoot, 'client/public/manuals');

async function capture(page, filename) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(250);
  const docsPath = path.join(docsOutputDir, filename);
  await page.screenshot({ path: docsPath, fullPage: false });
  await fs.copyFile(docsPath, path.join(publicOutputDir, filename));
}

test('capture current user-manual screenshots', async ({ browser, request }) => {
  test.skip(process.env.QCLICKER_CAPTURE_MANUALS !== '1', 'Run with QCLICKER_CAPTURE_MANUALS=1.');
  test.setTimeout(360_000);

  await fs.mkdir(docsOutputDir, { recursive: true });
  await fs.mkdir(publicOutputDir, { recursive: true });

  const { admin, professor, student } = await seedUsers(request);
  const course = await createCourseViaApi(request, admin.token, {
    name: 'Introduction to Biology',
    deptCode: 'BIOL',
    courseNumber: '101',
    section: '01',
    semester: 'Fall 2026',
  });
  await addInstructorToCourseViaApi(request, admin.token, course._id, professor.user._id);
  await enrollStudentViaApi(request, student.token, course.enrollmentCode);
  const courseUpdate = await apiJson(request, 'PATCH', `/courses/${course._id}`, {
    token: admin.token,
    payload: {
      allowStudentQuestions: true,
      courseChatEnabled: true,
      courseChatRetentionDays: 30,
      tags: [
        { value: 'Cell biology', label: 'Cell biology' },
        { value: 'Genetics', label: 'Genetics' },
        { value: 'Ecology', label: 'Ecology' },
      ],
    },
  });
  expect(courseUpdate.response.status(), JSON.stringify(courseUpdate.body)).toBe(200);

  const interactive = await createSessionViaApi(request, admin.token, course._id, {
    name: 'Cell Structure Check-in',
    description: 'Interactive questions and discussion for Week 2.',
    status: 'visible',
  });
  const interactiveQuestion = await createQuestionViaApi(request, admin.token, {
    courseId: course._id,
    content: '<p>Which organelle produces most of a cell\'s ATP?</p>',
    plainText: "Which organelle produces most of a cell's ATP?",
    solution: '<p>The <strong>mitochondrion</strong> produces most ATP during cellular respiration.</p>',
    solution_plainText: 'The mitochondrion produces most ATP during cellular respiration.',
    tags: [{ value: 'Cell biology', label: 'Cell biology' }],
    options: [
      { answer: 'Nucleus', correct: false },
      { answer: 'Mitochondrion', correct: true },
      { answer: 'Golgi apparatus', correct: false },
      { answer: 'Lysosome', correct: false },
    ],
  });
  await addQuestionToSessionViaApi(request, admin.token, interactive._id, interactiveQuestion._id);
  const shortAnswer = await createQuestionViaApi(request, admin.token, {
    type: 2,
    courseId: course._id,
    content: '<p>Describe one difference between plant and animal cells.</p>',
    plainText: 'Describe one difference between plant and animal cells.',
    solution: '<p>Plant cells have a cellulose cell wall; animal cells do not.</p>',
    solution_plainText: 'Plant cells have a cellulose cell wall; animal cells do not.',
    tags: [{ value: 'Cell biology', label: 'Cell biology' }],
    sessionOptions: { points: 3 },
  });
  await addQuestionToSessionViaApi(request, admin.token, interactive._id, shortAnswer._id);

  await createQuestionViaApi(request, admin.token, {
    type: 1,
    courseId: course._id,
    content: '<p>DNA is replicated before a cell divides.</p>',
    plainText: 'DNA is replicated before a cell divides.',
    public: true,
    publicOnQlickerForStudents: true,
    tags: [{ value: 'Genetics', label: 'Genetics' }],
    options: [
      { answer: 'True', correct: true },
      { answer: 'False', correct: false },
    ],
  });
  await createQuestionViaApi(request, admin.token, {
    type: 4,
    courseId: course._id,
    content: '<p>How many chromosomes are in a typical human somatic cell?</p>',
    plainText: 'How many chromosomes are in a typical human somatic cell?',
    correctNumerical: 46,
    toleranceNumerical: 0,
    public: true,
    publicOnQlickerForStudents: true,
    tags: [{ value: 'Genetics', label: 'Genetics' }],
  });

  const completedQuiz = await createSessionViaApi(request, admin.token, course._id, {
    name: 'Cell Biology Review Quiz',
    description: 'A completed quiz with released feedback.',
    quiz: true,
    status: 'visible',
    quizStart: new Date(Date.now() - ONE_HOUR_MS).toISOString(),
    quizEnd: new Date(Date.now() + ONE_HOUR_MS).toISOString(),
  });
  await patchSessionViaApi(request, professor.token, completedQuiz._id, {
    quiz: true,
    status: 'visible',
    quizStart: new Date(Date.now() - ONE_HOUR_MS).toISOString(),
    quizEnd: new Date(Date.now() + ONE_HOUR_MS).toISOString(),
  });
  const quizQuestion = await createQuestionViaApi(request, admin.token, {
    courseId: course._id,
    content: '<p>Which structure controls what enters and leaves the cell?</p>',
    plainText: 'Which structure controls what enters and leaves the cell?',
    solution: '<p>The plasma membrane is selectively permeable.</p>',
    solution_plainText: 'The plasma membrane is selectively permeable.',
    options: [
      { answer: 'Cell membrane', correct: true },
      { answer: 'Ribosome', correct: false },
      { answer: 'Nucleolus', correct: false },
      { answer: 'Cytoskeleton', correct: false },
    ],
    sessionOptions: { points: 2 },
  });
  const completedWithQuestion = await addQuestionToSessionViaApi(
    request,
    admin.token,
    completedQuiz._id,
    quizQuestion._id,
  );
  const completedQuestionId = String(completedWithQuestion.questions.at(-1));
  const quizResponse = await apiJson(request, 'PATCH', `/sessions/${completedQuiz._id}/quiz-response`, {
    token: student.token,
    payload: { questionId: completedQuestionId, answer: '0' },
  });
  expect(quizResponse.response.status(), JSON.stringify(quizResponse.body)).toBe(200);
  const quizSubmission = await apiJson(request, 'POST', `/sessions/${completedQuiz._id}/submit`, {
    token: student.token,
  });
  expect(quizSubmission.response.status(), JSON.stringify(quizSubmission.body)).toBe(200);
  await patchSessionViaApi(request, professor.token, completedQuiz._id, {
    status: 'done',
    reviewable: true,
  });
  const gradeRecalculation = await apiJson(
    request,
    'POST',
    `/sessions/${completedQuiz._id}/grades/recalculate`,
    { token: professor.token, payload: { missingOnly: false } },
  );
  expect(gradeRecalculation.response.status(), JSON.stringify(gradeRecalculation.body)).toBe(200);

  const activeQuiz = await createSessionViaApi(request, admin.token, course._id, {
    name: 'Unit 1 Quiz',
    description: 'Complete all questions before submitting.',
    quiz: true,
    status: 'visible',
    quizStart: new Date(Date.now() - ONE_MINUTE_MS).toISOString(),
    quizEnd: new Date(Date.now() + ONE_HOUR_MS).toISOString(),
  });
  await patchSessionViaApi(request, professor.token, activeQuiz._id, {
    quiz: true,
    status: 'visible',
    quizStart: new Date(Date.now() - ONE_MINUTE_MS).toISOString(),
    quizEnd: new Date(Date.now() + ONE_HOUR_MS).toISOString(),
  });
  const activeQuizQuestion = await createQuestionViaApi(request, admin.token, {
    courseId: course._id,
    content: '<p>Which molecule carries genetic information?</p>',
    plainText: 'Which molecule carries genetic information?',
    options: [
      { answer: 'ATP', correct: false },
      { answer: 'DNA', correct: true },
      { answer: 'Glucose', correct: false },
      { answer: 'Lipid', correct: false },
    ],
  });
  await addQuestionToSessionViaApi(request, admin.token, activeQuiz._id, activeQuizQuestion._id);

  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await loginViaUi(adminPage, admin.email, admin.password, /\/admin$/);
  await expect(adminPage.getByRole('heading', { name: /admin dashboard/i })).toBeVisible();
  await capture(adminPage, 'admin-dashboard.png');
  await adminPage.getByRole('tab', { name: /^Storage$/i }).click();
  await expect(adminPage.getByText(/Storage provider settings are saved in the database/i)).toBeVisible();
  await capture(adminPage, 'admin-storage.png');
  await adminPage.getByRole('tab', { name: /^Users$/i }).click();
  await expect(adminPage.getByPlaceholder(/search by name or email/i)).toBeVisible();
  await capture(adminPage, 'admin-users.png');

  const professorContext = await browser.newContext();
  const professorPage = await professorContext.newPage();
  await loginViaUi(professorPage, professor.email, professor.password, /\/prof$/);
  await expect(professorPage.getByText('BIOL 101: Introduction to Biology')).toBeVisible();
  await capture(professorPage, 'professor-dashboard.png');
  await professorPage.goto(`/prof/course/${course._id}`);
  await expect(professorPage.getByRole('heading', { name: /Introduction to Biology/i })).toBeVisible();
  await capture(professorPage, 'professor-course.png');
  await professorPage.getByRole('tab', { name: /^Course Settings$/i }).click();
  await expect(professorPage.getByText(new RegExp(course.enrollmentCode))).toBeVisible();
  await capture(professorPage, 'professor-course-settings.png');
  await professorPage.getByRole('tab', { name: /^Question Library$/i }).click();
  await expect(professorPage.getByText(/DNA is replicated before a cell divides/i)).toBeVisible();
  await capture(professorPage, 'professor-question-library.png');
  await professorPage.getByRole('tab', { name: /^Groups$/i }).click();
  await professorPage.getByRole('button', { name: /^Create Category$/i }).click();
  await professorPage.getByLabel(/^Category Name$/i).fill('Lab Teams');
  await professorPage.getByLabel(/^Number of Groups$/i).fill('3');
  await professorPage.getByRole('button', { name: /^Create$/i }).click();
  await expect(professorPage.getByText(/^Group 1$/i)).toBeVisible();
  await capture(professorPage, 'professor-groups.png');
  await professorPage.goto(`/prof/course/${course._id}/session/${interactive._id}`);
  await expect(professorPage.getByText('Cell Structure Check-in').first()).toBeVisible();
  await capture(professorPage, 'session-editor.png');

  await professorPage.goto(`/prof/course/${course._id}`);
  await professorPage.getByRole('button', { name: /Launch session Cell Structure Check-in/i }).click();
  await expect(professorPage).toHaveURL(new RegExp(`/session/${interactive._id}/live$`));
  const visibleToggle = professorPage.getByLabel(/^Visible$/i);
  if (!(await visibleToggle.isChecked())) await visibleToggle.click();
  await expect(professorPage.getByText(/Which organelle produces most of a cell's ATP/i)).toBeVisible();
  await capture(professorPage, 'professor-live-session.png');

  await professorPage.goto(`/prof/course/${course._id}`);
  await professorPage.getByRole('tab', { name: /^Grades$/i }).click();
  await professorPage.getByRole('button', { name: /^Show Grade Table$/i }).click();
  const gradeDialog = professorPage.getByRole('dialog', { name: /select sessions for grade table/i });
  await gradeDialog.getByText('Cell Biology Review Quiz').click();
  await gradeDialog.getByRole('button', { name: /^Show Table$/i }).click();
  await expect(professorPage.getByText(student.email)).toBeVisible();
  await capture(professorPage, 'professor-grades.png');

  const studentContext = await browser.newContext();
  const studentPage = await studentContext.newPage();
  await loginViaUi(studentPage, student.email, student.password, /\/student$/);
  await expect(studentPage.getByText('BIOL 101: Introduction to Biology', { exact: true })).toBeVisible();
  await capture(studentPage, 'student-dashboard.png');
  await studentPage.goto(`/student/course/${course._id}`);
  await expect(studentPage.getByRole('heading', { name: /Introduction to Biology/i })).toBeVisible();
  await capture(studentPage, 'student-course.png');
  await studentPage.getByRole('button', { name: /Cell Structure Check-in/i }).first().click();
  await expect(studentPage.getByText(/Which organelle produces most of a cell's ATP/i)).toBeVisible();
  await capture(studentPage, 'student-live-session.png');
  await studentPage.goto(`/student/course/${course._id}/session/${activeQuiz._id}/quiz`);
  await expect(studentPage.getByText(/Which molecule carries genetic information/i)).toBeVisible();
  await capture(studentPage, 'student-quiz.png');
  await studentPage.goto(`/student/course/${course._id}/session/${completedQuiz._id}/review`);
  await expect(studentPage.getByText(/Which structure controls what enters and leaves the cell/i)).toBeVisible();
  await capture(studentPage, 'student-review.png');
  await studentPage.goto(`/student/course/${course._id}/practice-sessions/new`);
  await expect(studentPage.getByRole('heading', { name: /^New practice session$/i })).toBeVisible();
  await capture(studentPage, 'student-practice-session.png');

  await adminContext.close();
  await professorContext.close();
  await studentContext.close();
});
