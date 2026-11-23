import { expect, test } from '@playwright/test';
import { expectNoCriticalAccessibilityViolations, loginViaUi, seedUsers } from './helpers.js';

test('visitors can read the notice from the landing and registration pages', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByRole('link', { name: 'Privacy', exact: true }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page).toHaveTitle('Your data in Qlicker | Qlicker');
  await expect(page.getByRole('heading', { level: 1, name: 'Your data in Qlicker' })).toBeFocused();
  await expect(page.getByRole('heading', { name: 'What does anonymous mean?' })).toBeVisible();
  await expectNoCriticalAccessibilityViolations(page);
  await page.screenshot({ path: testInfo.outputPath('privacy-desktop.png'), fullPage: true });

  await page.setViewportSize({ width: 320, height: 740 });
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your data in Qlicker');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('privacy-mobile.png'), fullPage: true });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/login');
  await expect(page.getByRole('link', { name: 'Privacy', exact: true })).toHaveAttribute('href', '/privacy');
  await page.getByRole('tab', { name: 'Register', exact: true }).click();
  await page.getByRole('link', { name: 'Privacy', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your data in Qlicker');
});

test('signed-in users can open the notice from their account menu and return', async ({ page, request }) => {
  const { student } = await seedUsers(request, { professor: false });
  await loginViaUi(page, student.email, student.password, /\/student$/);
  await page.getByRole('button', { name: /open account menu/i }).click();
  await page.getByRole('menuitem', { name: 'Privacy', exact: true }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your data in Qlicker');
  await page.getByRole('link', { name: /go to dashboard/i }).click();
  await expect(page).toHaveURL(/\/student$/);
  await expect(page.getByRole('button', { name: /open account menu/i })).toBeVisible();
});
