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
