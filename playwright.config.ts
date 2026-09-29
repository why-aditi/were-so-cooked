import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests (section 13): "Demo sign-in → add pantry → plan →
 * substitution → grocery list, run against the preview deploy."
 *
 * `E2E_BASE_URL` points at whatever is being tested — a PR's preview
 * deploy, production during the post-merge smoke test, or a local
 * `wrangler dev`. Nothing here assumes localhost, because the case that
 * matters is the deployed one.
 *
 * The `setup` project signs in once and every other project reuses that
 * session. Section 9 caps demo accounts at five per IP per hour, so a
 * suite that signed in per test would spend its budget on the rate limiter
 * rather than the product.
 */

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:8787';
const SESSION_FILE = 'e2e/.auth/session.json';

export default defineConfig({
  testDir: './e2e',
  // A demo account is a real account with a real agent. Running specs in
  // parallel against one of them makes the tests race each other's pantry.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  timeout: 45_000,
  expect: {
    // Section 1's bar is "within 2 minutes" for the whole flow, so a single
    // assertion waiting 10 seconds is already a problem.
    timeout: 10_000,
  },
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], storageState: SESSION_FILE },
      dependencies: ['setup'],
    },
    // Section 10 puts the nav in a bottom tab bar on phones, and that is a
    // different component rather than the same one restyled.
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'], storageState: SESSION_FILE },
      dependencies: ['setup'],
    },
  ],
});
