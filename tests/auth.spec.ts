import { expect, test } from './fixtures';
import AxeBuilder from '@axe-core/playwright';

test('password-only gate blurs the journal and unlocks without a username', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('still-theme', 'night'));
  await page.route('**/api/auth/status', route => route.fulfill({ json: { enabled: true, authenticated: false } }));
  await page.route('**/api/auth/login', async route => {
    const body = route.request().postDataJSON() as { password: string };
    await route.fulfill(body.password === 'correct horse' ? { status: 204, body: '' } : { status: 401, json: { detail: 'Wrong password.' } });
  });
  await page.goto('/');

  const dialog = page.getByRole('dialog', { name: 'Password required', exact: true });
  const password = dialog.getByLabel('Password', { exact: true });
  await expect(dialog).toBeVisible();
  await expect(password).toBeFocused();
  await expect(page.getByTestId('auth-surface')).toHaveCSS('filter', 'blur(7px)');
  await expect(page.getByTestId('auth-surface')).toHaveCSS('transition-duration', '0.26s');
  await expect(page.getByTestId('locked-document-preview')).toHaveCount(0);
  await expect(page.getByTestId('locked-log-preview')).toHaveCount(0);
  const label = dialog.getByText('password', { exact: true });
  await expect(label).toBeVisible();
  await expect(dialog.getByText(/username/i)).toHaveCount(0);
  const labelBox = (await label.boundingBox())!, inputBox = (await password.boundingBox())!;
  expect(Math.abs(labelBox.y + labelBox.height - (inputBox.y + inputBox.height))).toBeLessThanOrEqual(1);
  await expect(dialog.locator('form')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(dialog.locator('form')).toHaveCSS('box-shadow', 'none');
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);

  await password.fill('wrong'); await password.press('Enter');
  await expect(dialog.getByText('wrong password', { exact: true })).toBeVisible();
  await password.fill('correct horse'); await password.press('Enter');

  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('auth-surface')).toHaveCSS('filter', 'blur(0px)');
  await expect(page.getByTestId('auth-surface')).not.toHaveAttribute('inert');
  await expect(page.getByTestId('auth-surface')).not.toHaveAttribute('aria-hidden');
  await expect(page.getByRole('textbox', { name: 'New note', exact: true })).toBeVisible();
});

// A link to one entry, opened by someone the rest of the logbook is closed to.
const lockedWithShare = async (page: import('./fixtures').Page, shared: unknown, status = 200) => {
  await page.route('**/api/auth/status', route => route.fulfill({ json: { enabled: true, authenticated: false } }));
  await page.route('**/api/auth/login', async route => {
    const body = route.request().postDataJSON() as { password: string };
    await route.fulfill(body.password === 'correct horse' ? { status: 204, body: '' } : { status: 401, json: { detail: 'Wrong password.' } });
  });
  await page.route('**/api/share/**', route => route.fulfill(status === 200
    ? { json: shared }
    : { status, json: { detail: 'That item no longer exists.' } }));
};

const SHARED = {
  date: '2026-10-24',
  entry: { id: 7, kind: 'notes', parent_id: null, document: null, content: 'The entry that was shared', tags: [], created_at: '2026-10-24T10:00:00Z', completed_at: null },
  children: [
    { id: 8, kind: 'notes', parent_id: 7, document: null, content: 'Written beneath it', tags: [], created_at: '2026-10-24T10:01:00Z', completed_at: null },
    { id: 9, kind: 'notes', parent_id: 7, document: null, content: 'And this as well', tags: [], created_at: '2026-10-24T10:02:00Z', completed_at: null },
  ],
};

test('a shared link shows its entry while the rest of the logbook stays closed', async ({ page }) => {
  await lockedWithShare(page, SHARED);
  await page.goto('/#e/notes/7/0123456789abcdef');

  // The entry, what is written beneath it, and the day it was written on.
  const preview = page.getByTestId('shared-entry-preview');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('The entry that was shared');
  await expect(preview).toContainText('Written beneath it');
  await expect(preview).toContainText('And this as well');
  await expect(preview).toContainText('October 24, 2026');
  await expect(preview).toHaveCSS('filter', 'none');
  // Nothing has been asked of the reader yet, and the journal behind it is
  // blurred and out of reach as it always is while locked.
  await expect(page.getByRole('dialog', { name: 'Password required', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('auth-surface')).toHaveCSS('filter', 'blur(7px)');
  await expect(page.getByTestId('auth-surface')).toHaveAttribute('inert', '');
  // The card rises into place; it is the settled colours that are audited.
  await page.waitForTimeout(500);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
});

test('reaching past a shared entry asks for the password', async ({ page }) => {
  await lockedWithShare(page, SHARED);
  await page.goto('/#e/notes/7/0123456789abcdef');
  await expect(page.getByTestId('shared-entry-preview')).toBeVisible();
  const dialog = page.getByRole('dialog', { name: 'Password required', exact: true });
  await expect(dialog).toHaveCount(0);

  // A press on the blurred journal is a reach for the rest of it.
  await page.mouse.click(40, 600);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Password', { exact: true })).toBeFocused();
});

test('a key pressed past a shared entry asks for the password', async ({ page }) => {
  await lockedWithShare(page, SHARED);
  await page.goto('/#e/notes/7/0123456789abcdef');
  await expect(page.getByTestId('shared-entry-preview')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('dialog', { name: 'Password required', exact: true })).toBeVisible();
});

test('a link that does not answer reveals nothing and reads as a locked journal', async ({ page }) => {
  await lockedWithShare(page, null, 404);
  await page.goto('/#e/notes/7/ffffffffffffffff');
  await expect(page.getByRole('dialog', { name: 'Password required', exact: true })).toBeVisible();
  await expect(page.getByTestId('shared-entry-preview')).toHaveCount(0);
  await expect(page.getByTestId('auth-surface')).toHaveCSS('filter', 'blur(7px)');
});
