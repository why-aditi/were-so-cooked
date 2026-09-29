import { expect, test as setup } from '@playwright/test';

/**
 * Signs in once and saves the session for every other spec.
 *
 * Section 9 allows five demo accounts per IP per hour. A suite that started
 * a fresh demo in each test burned through that in the first two minutes
 * and then tested the rate limiter instead of the product — the failures
 * looked like broken navigation and were actually the server correctly
 * saying no.
 *
 * Sharing one session is also closer to what the flow being tested
 * actually is: section 1's bar is a reviewer clicking "try the demo" once
 * and then looking around.
 */

export const SESSION_FILE = 'e2e/.auth/session.json';

setup('start a demo account', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /try the demo/i }).click();

  // The redirect is the proof the session cookie was set; storageState
  // written before it lands would be empty.
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByPlaceholder(/bought 1kg paneer/i)).toBeVisible();

  await page.context().storageState({ path: SESSION_FILE });
});
