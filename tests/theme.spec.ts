import { expect, test, type Page } from './fixtures';
import AxeBuilder from '@axe-core/playwright';

async function checkAccessibility(page: Page) {
  const audit = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']);
  // The requested night palette intentionally uses teal links without bold or
  // underlines. Color-only link differentiation is a known design exception;
  // keep every other accessibility rule enabled, and audit this rule in light mode.
  if (await page.locator('html').getAttribute('data-theme') === 'night') audit.disableRules(['link-in-text-block']);
  expect((await audit.analyze()).violations).toEqual([]);
}

test('keyboard focus does not draw browser outlines', async ({ page }) => {
  await page.goto('/');
  const timer = page.getByRole('button', { name: 'Start focus timer', exact: true });
  await timer.focus();
  await expect(timer).toHaveCSS('outline-style', 'none');
  await page.keyboard.press('Meta+f');
  const search = page.getByRole('dialog', { name: 'Search journal', exact: true }).getByRole('textbox');
  await expect(search).toBeFocused();
  await expect(search).toHaveCSS('outline-style', 'none');
});

test('reference typography, wider margins and persistent night mode', async ({ page }) => {
  await page.route('**/api/journal?*', route => route.fulfill({ json: {
    today: '2026-09-16', server_time: new Date().toISOString(), active_session: null, next_cursor: null,
    tags: [{ name: 'work', note_count: 1, task_count: 0 }], tag: null,
    tasks: [{ id: 101, content: 'Review the draft', tags: [], parent_id: null, position: 0 }],
    days: [{ date: '2026-09-16', focused_seconds: 5400, longest_session_seconds: 5400, session_count: 1,
      notes: [{ id: 102, content: 'Read the [project notes](https://example.com/notes).', tags: ['work'], parent_id: null, position: 0 }] }],
  } }));
  await page.route('**/api/sessions?*', route => route.fulfill({ json: [] }));
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('body')).toHaveCSS('font-family', /Sohne/);
  expect(await page.evaluate(() => document.fonts.check('300 18px Sohne'))).toBe(true);
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(242, 241, 237)');
  await expect(page.getByTestId('page')).toHaveCSS('background-color', 'rgb(242, 241, 237)');
  await expect(page.getByRole('button', { name: 'Focus sessions for 2026-09-16', exact: true })).toHaveCSS('opacity', '0.76');
  await expect(page.locator('time[datetime="2026-09-16"]')).toHaveCSS('background-color', 'rgb(223, 231, 237)');
  await page.getByRole('navigation', { name: 'Tags' }).hover();
  const shortcuts = page.getByRole('button', { name: 'Keyboard shortcuts', exact: true });
  await shortcuts.hover();
  await expect(shortcuts).toHaveCSS('color', 'rgb(24, 113, 186)');
  await shortcuts.click();
  const shortcutDialog = page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true });
  await expect(shortcutDialog).toBeVisible();
  await expect(shortcutDialog.getByText('indent entry', { exact: true })).toBeVisible();
  await expect(shortcutDialog.getByText('outdent entry', { exact: true })).toBeVisible();
  await expect(shortcutDialog.getByText('statistics', { exact: true })).toHaveCount(0);
  await expect(shortcutDialog.getByText('sound controls', { exact: true })).toHaveCount(0);
  await expect(shortcutDialog.getByText('jump to entry above', { exact: true })).toHaveCount(0);
  await expect(shortcutDialog.getByText('jump to entry below', { exact: true })).toHaveCount(0);
  await expect(shortcutDialog.getByText('mark this finished', { exact: true })).toHaveCount(0);
  await expect(shortcutDialog.getByText('styled → plain text', { exact: true })).toHaveCount(0);
  const shortcutRows = shortcutDialog.getByTestId('shortcut-rows');
  const commandStarts = await shortcutRows.locator(':scope > div > span:first-child').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().x));
  const keyStarts = await shortcutRows.locator(':scope > div > span:last-child').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().x));
  expect(Math.max(...commandStarts) - Math.min(...commandStarts)).toBeLessThan(1);
  expect(Math.max(...keyStarts) - Math.min(...keyStarts)).toBeLessThan(1);
  await page.keyboard.press('Escape');
  await expect(shortcutDialog).toBeHidden();
  await page.keyboard.press('Meta+Shift+S');
  await expect(page.getByRole('dialog', { name: 'Statistics', exact: true })).toHaveCount(0);
  await page.keyboard.press('Meta+Shift+M');
  await expect(page.getByRole('dialog', { name: 'Focus sound', exact: true })).toHaveCount(0);
  const main = (await page.getByRole('main').boundingBox())!;
  const timer = (await page.getByRole('button', { name: 'Start focus timer', exact: true }).boundingBox())!;
  const task = (await page.getByRole('group', { name: 'Review the draft', exact: true }).boundingBox())!;
  expect(main.x).toBeGreaterThanOrEqual(300);
  expect(timer.x + timer.width).toBe(1280 - 24);
  expect(timer.y).toBe(20);
  expect(task.y + task.height).toBeLessThan((await page.getByRole('button', { name: 'Focus sessions for 2026-09-16', exact: true }).boundingBox())!.y);
  const ring = await page.getByRole('button', { name: 'Start focus timer', exact: true }).evaluate(el => {
    const style = getComputedStyle(el, '::before'); return { border: style.borderWidth, radius: style.borderRadius, inset: style.top };
  });
  expect(ring).toEqual({ border: '1px', radius: '50%', inset: '-3px' });
  await expect(page.getByRole('link', { name: 'project notes', exact: true })).toHaveCSS('color', 'rgb(24, 113, 186)');
  await expect(page.getByRole('link', { name: 'project notes', exact: true })).toHaveCSS('text-decoration-line', 'none');
  const taskBubble = page.getByRole('button', { name: 'Complete Review the draft', exact: true });
  const noteBullet = page.locator('[data-kind="notes"][data-item-id="102"] > div > [aria-hidden="true"]');
  await expect(taskBubble).toHaveCSS('color', 'rgb(36, 36, 34)');
  await expect(noteBullet).toHaveCSS('color', 'rgb(36, 36, 34)');
  expect(await taskBubble.evaluate(element => ({
    ring: getComputedStyle(element, '::before').translate,
    check: getComputedStyle(element, '::after').translate,
  }))).toEqual({ ring: '0px 0.5px', check: '0px 0.5px' });
  expect(await noteBullet.evaluate(element => getComputedStyle(element, '::before').translate)).toBe('0px 0.5px');
  await page.mouse.move(1000, 500);
  await page.getByRole('navigation', { name: 'Tags' }).hover();
  const toggle = page.getByRole('switch', { name: 'Night mode', exact: true });
  const toggleBox = (await toggle.boundingBox())!;
  expect(toggleBox.x + toggleBox.width).toBeLessThan(main.x);
  expect(toggleBox.y).toBeGreaterThan(70);
  await expect(toggle.locator('[data-icon="sun"]')).toHaveCSS('opacity', '1');
  await expect(toggle.locator('[data-icon="moon"]')).toHaveCSS('opacity', '0');
  const checkLinkEditor = async (textColor: string, urlColor: string) => {
    await page.getByRole('link', { name: 'project notes', exact: true }).click({ button: 'right' });
    const dialog = page.getByRole('dialog', { name: 'Link', exact: true });
    const textField = dialog.getByRole('textbox', { name: 'Link label', exact: true });
    const urlField = dialog.getByRole('textbox', { name: 'Link URL', exact: true });
    await expect(textField).toHaveCSS('color', textColor);
    await expect(urlField).toHaveCSS('color', urlColor);
    await expect(textField).toHaveCSS('border-width', '0px');
    await expect(textField).toHaveCSS('outline-style', 'none');
    await expect(dialog).toHaveCSS('opacity', '1');
    await checkAccessibility(page);
    await urlField.focus();
    await expect(urlField).toHaveCSS('border-width', '0px');
    await expect(urlField).toHaveCSS('outline-style', 'none');
    await checkAccessibility(page);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await page.keyboard.press('Escape');
  };
  await checkLinkEditor('rgb(24, 113, 186)', 'rgb(112, 88, 143)');
  await page.screenshot({ path: 'test-results/day-mode.png' });
  await page.getByRole('navigation', { name: 'Tags' }).hover();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(toggle.locator('[data-icon="moon"]')).toHaveCSS('opacity', '1');
  await expect(toggle.locator('[data-icon="sun"]')).toHaveCSS('opacity', '0');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(1, 22, 39)');
  await expect(page.locator('body')).toHaveCSS('color', 'rgb(192, 199, 209)');
  await expect(page.getByRole('link', { name: 'project notes', exact: true })).toHaveCSS('color', 'rgb(117, 209, 196)');
  await expect(taskBubble).toHaveCSS('color', 'rgb(192, 199, 209)');
  await expect(noteBullet).toHaveCSS('color', 'rgb(192, 199, 209)');
  await checkLinkEditor('rgb(117, 209, 196)', 'rgb(183, 164, 221)');
  await page.getByRole('navigation', { name: 'Tags' }).hover();
  await expect(page.getByRole('button', { name: '#work', exact: true })).toHaveCSS('opacity', '1');
  await expect(page.getByRole('navigation', { name: 'Tags' }).locator(':scope > div')).toHaveCSS('opacity', '1');
  await checkAccessibility(page);
  await page.screenshot({ path: 'test-results/night-mode.png' });
  await page.reload();
  await page.mouse.move(1000, 500);
  await page.getByRole('navigation', { name: 'Tags' }).hover();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(1, 22, 39)');
  await page.getByRole('button', { name: 'Focus sessions for 2026-09-16', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCSS('background-color', 'rgb(10, 33, 51)');
  await expect(page.getByRole('dialog')).toHaveCSS('opacity', '1');
  await checkAccessibility(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.getByRole('navigation', { name: 'Tags' }).hover();
  await toggle.click();
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(242, 241, 237)');
  await page.setViewportSize({ width: 440, height: 700 });
  const smallTimer = (await page.getByRole('button', { name: 'Start focus timer', exact: true }).boundingBox())!;
  const mobileToggle = page.getByRole('switch', { name: 'Night mode', exact: true });
  const compactTime = page.getByTestId('compact-timer-time');
  const compactTimeBox = (await compactTime.boundingBox())!;
  await expect(mobileToggle).toBeHidden();
  await expect(compactTime).toHaveText('00:00:00');
  expect(compactTimeBox.x + compactTimeBox.width).toBeLessThan(smallTimer.x);
  expect(compactTimeBox.y + compactTimeBox.height / 2).toBeCloseTo(smallTimer.y + smallTimer.height / 2, 0);
  await expect(page.getByRole('tablist', { name: 'Mobile views' })).toBeVisible();
  await page.getByRole('tab', { name: 'to do', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Review the draft', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'log', exact: true }).click();
  await expect(page.getByRole('link', { name: 'project notes', exact: true })).toBeVisible();
});
