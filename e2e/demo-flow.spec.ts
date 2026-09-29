import { type Page, expect, test } from '@playwright/test';

/**
 * The demo flow from section 13, against a deployed Worker.
 *
 * Section 1 sets the bar this defends: "A reviewer can open the live URL,
 * click 'try the demo', and see a plan, a substitution and a trending
 * recipe within 2 minutes."
 *
 * ## Two things shape how this suite is written
 *
 * **One session, shared.** Section 9 allows five demo accounts per IP per
 * hour. `auth.setup.ts` signs in once and every test here reuses that
 * session — which is also closer to the flow being tested. The cost is
 * that tests share a pantry and a profile, so each one below either
 * creates what it needs or reads the current state rather than assuming a
 * clean account.
 *
 * **The AI steps are opt-in.** A chat turn costs 71.6 measured neurons
 * against an account ceiling of 10,000 per rolling 24 hours (section 12).
 * A suite that sent a message on every pull request would spend the
 * product's budget proving something the integration tests already prove
 * offline. Those tests run with `E2E_LIVE_AI=true`.
 */

const LIVE_AI = process.env.E2E_LIVE_AI === 'true';

/**
 * A pantry row by name.
 *
 * Scoped to the list item rather than matched on text: the edit and remove
 * buttons carry screen-reader labels containing the same name, so a bare
 * `getByText` matches three elements and fails strict mode. Good
 * accessibility making a naive locator ambiguous is the right trade.
 */
const pantryRow = (page: Page, name: string) =>
  page.getByRole('listitem').filter({ has: page.getByText(name, { exact: true }) });

/* -------------------------------- signed out ------------------------------ */

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('the landing page offers both ways in', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: /sign in with github/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /try the demo/i })).toBeVisible();
    // That the button works is proved by auth.setup.ts, which every other
    // test depends on. Clicking it again would spend one of the five demo
    // accounts section 9 allows per hour.
  });

  test('the skip link is the first thing a keyboard reaches', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');

    const skip = page.getByRole('link', { name: /skip to content/i });
    await expect(skip).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main')).toBeVisible();
  });
});

/* -------------------------------- the flow -------------------------------- */

test.describe('the demo flow', () => {
  test('the pantry accepts free text and resolves it', async ({ page }) => {
    await page.goto('/app/pantry');

    await page.getByLabel(/add items by typing/i).fill('1kg paneer, 6 eggs and a bunch of dhaniya');
    await page.getByRole('button', { name: /^add$/i }).click();

    // All three resolved, including the Hindi name — the section 4 promise
    // the rest of the pantry rests on.
    await expect(pantryRow(page, 'paneer')).toBeVisible();
    await expect(pantryRow(page, 'egg')).toBeVisible();
    await expect(pantryRow(page, 'coriander leaves')).toBeVisible();
  });

  test('an item can be removed and put back', async ({ page }) => {
    await page.goto('/app/pantry');

    const rows = pantryRow(page, 'basmati rice');
    const before = await rows.count();

    await page.getByLabel(/add items by typing/i).fill('2kg basmati chawal');
    await page.getByRole('button', { name: /^add$/i }).click();
    await expect(rows).toHaveCount(before + 1);

    // Counted rather than checking the row disappeared. The desktop and
    // mobile projects share one demo account (section 9 allows five per
    // hour), so an earlier run may have left a row of the same name — and
    // `toBeHidden` on a name that still matches something else is a test
    // that fails for the wrong reason.
    await page.getByRole('button', { name: /remove basmati rice/i }).first().click();
    await expect(rows).toHaveCount(before);

    // Soft delete, so undo restores rather than re-adds.
    await page.getByRole('button', { name: /^undo$/i }).click();
    await expect(rows).toHaveCount(before + 1);
  });

  test('every diet and allergen is selectable', async ({ page }) => {
    await page.goto('/app/profile');

    const allergens = page.getByRole('group', { name: /allergens/i });
    const diets = page.getByRole('group', { name: /^diets$/i });

    // Section 7's full sets, rendered from the schema rather than a list
    // someone has to remember to extend.
    await expect(allergens.getByRole('checkbox')).toHaveCount(14);
    await expect(diets.getByRole('checkbox')).toHaveCount(18);
  });

  test('a saved profile survives a reload', async ({ page }) => {
    await page.goto('/app/profile');

    const jain = page
      .getByRole('group', { name: /^diets$/i })
      .getByRole('checkbox', { name: 'Jain' });

    // Toggled to whatever it is not, so the test does not depend on what an
    // earlier one left behind.
    const wasChecked = await jain.isChecked();
    await jain.setChecked(!wasChecked);
    await page.getByRole('button', { name: /save changes/i }).click();
    await expect(page.getByText('Saved')).toBeVisible();

    await page.reload();
    await expect(jain).toBeChecked({ checked: !wasChecked });
  });

  test('removing an allergen warns in plain language', async ({ page }) => {
    await page.goto('/app/profile');

    const peanuts = page
      .getByRole('group', { name: /allergens/i })
      .getByRole('checkbox', { name: 'Peanuts' });

    // The warning compares against the *saved* profile, so peanuts has to
    // be saved before unchecking it means anything.
    if (!(await peanuts.isChecked())) {
      await peanuts.check();
      await page.getByRole('button', { name: /save changes/i }).click();
      await expect(page.getByText('Saved')).toBeVisible();
    }

    await peanuts.uncheck();

    // Section 10: plain, sentence case, no emoji. The one warning in the
    // product that must never be funny.
    const warning = page.getByRole('alert');
    await expect(warning).toContainText('removes Peanuts from your allergy list');
    await expect(warning).not.toContainText('💀');

    // Left as it was found, so the next test starts where it expects to.
    await peanuts.check();
  });

  test('the plan and grocery screens load', async ({ page }) => {
    // Honest empty states, not spinners: `WeeklyPlanWorkflow` is not built
    // and neither screen fabricates a week to look finished.
    await page.goto('/app/plan');
    await expect(page.getByRole('heading', { name: /this week/i })).toBeVisible();

    await page.goto('/app/grocery');
    await expect(page.getByRole('heading', { name: /grocery/i })).toBeVisible();
  });

  test('trending loads with the diet filter on', async ({ page }) => {
    await page.goto('/app/trending');

    await expect(page.getByRole('heading', { name: /trending/i })).toBeVisible();
    // Section 11's `?fits=me`, on by default so the first thing a reviewer
    // sees is already filtered to what they can eat.
    await expect(page.getByLabel(/only what i can eat/i)).toBeChecked();
  });

  test('the budget meter is on the chat screen', async ({ page }) => {
    // Section 12's graceful degradation is a headline requirement, so the
    // number behind it is on screen rather than buried in a menu.
    await page.goto('/app');
    await expect(page.getByRole('meter', { name: /daily ai budget/i })).toBeVisible();
  });
});

/* ------------------------------ keyboard only ----------------------------- */

test.describe('keyboard support', () => {
  test('the app shell has a working skip link', async ({ page }) => {
    await page.goto('/app');

    // Focused directly rather than tabbed to: the shell mounts an agent
    // socket and re-renders as state arrives, so asserting tab *position*
    // here tests the timing of that rather than the link. Position is
    // covered on the landing page, which is static.
    const skip = page.getByRole('link', { name: /skip to content/i });
    await skip.focus();
    await expect(skip).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main')).toBeVisible();
  });

  test('a message can be composed with the keyboard alone', async ({ page }) => {
    await page.goto('/app');

    const composer = page.getByLabel(/message your kitchen agent/i);
    await composer.focus();
    await page.keyboard.type('hello');
    // Shift+Enter breaks the line rather than sending, which is the
    // convention every other chat box already taught people.
    await page.keyboard.press('Shift+Enter');
    await expect(composer).toHaveValue(/hello\n/);
  });

  test('the photo button is reachable and labelled', async ({ page }) => {
    await page.goto('/app');
    await expect(page.getByRole('button', { name: /attach a photo/i })).toBeVisible();
  });
});

/* -------------------------------- mobile nav ------------------------------ */

test.describe('phone navigation', () => {
  test.skip(({ isMobile }) => !isMobile, 'the tab bar only exists below md');

  test('the bottom tab bar reaches every section', async ({ page }) => {
    await page.goto('/app');

    const nav = page.getByRole('navigation', { name: /sections/i });
    for (const [label, path] of [
      ['Pantry', '/app/pantry'],
      ['Plan', '/app/plan'],
      ['Grocery', '/app/grocery'],
      ['More', '/app/more'],
      ['Chat', '/app'],
    ] as const) {
      await nav.getByRole('link', { name: new RegExp(label, 'i') }).click();
      await expect(page).toHaveURL(new RegExp(`${path.replace(/\//g, '\\/')}$`));
    }
  });
});

/* --------------------------- the parts that cost -------------------------- */

test.describe('chat turns', () => {
  test.skip(!LIVE_AI, 'costs neurons; run with E2E_LIVE_AI=true');

  test('a message gets an answer and a substitution', async ({ page }) => {
    await page.goto('/app');

    const composer = page.getByLabel(/message your kitchen agent/i);
    await composer.fill('bought 1kg paneer and a bunch of palak');
    await page.getByRole('button', { name: /^send$/i }).click();

    // The pantry-diff card, rendered from structured tool output.
    await expect(page.getByText(/fridge updated/i)).toBeVisible({ timeout: 30_000 });

    await composer.fill('palak paneer but vegan');
    await page.getByRole('button', { name: /^send$/i }).click();

    await expect(page.getByText(/rebuilt/i)).toBeVisible({ timeout: 30_000 });
  });

  test('log_cooked waits for approval before touching the pantry', async ({ page }) => {
    await page.goto('/app');

    const composer = page.getByLabel(/message your kitchen agent/i);
    await composer.fill('i made palak paneer');
    await page.getByRole('button', { name: /^send$/i }).click();

    // Section 5's human-in-the-loop flow: it names what is about to change
    // before either button is offered.
    const card = page.getByRole('region', { name: /confirm this deduction/i });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByRole('button', { name: 'Approve' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Reject' })).toBeVisible();
  });
});
