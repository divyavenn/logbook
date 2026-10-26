import { expect, test } from './fixtures';

// The platform layer: the handful of declarations that decide whether this
// reads as an installed thing or as a website being viewed on a phone.

test('the page is laid out past the notch and takes the status bar with it', async ({ page }) => {
  await page.goto('/');
  // Without this the safe-area insets the layout is padded by are all zero.
  const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
  expect(viewport).toContain('viewport-fit=cover');
  expect(viewport).toContain('width=device-width');
  // Never: the fields are sized so the page has no reason to zoom.
  expect(viewport).not.toContain('user-scalable');
  expect(viewport).not.toContain('maximum-scale');

  // The status bar is the paper at the top of the page, in either theme.
  const bar = page.locator('meta[name="theme-color"]');
  await expect(bar).toHaveAttribute('content', '#f2f1ed');
  const rail = page.getByRole('navigation', { name: 'Tags', exact: true });
  await rail.hover();
  await rail.getByRole('switch', { name: 'Night mode', exact: true }).click();
  await expect(bar).toHaveAttribute('content', '#011627');
  await page.reload();
  await expect(bar).toHaveAttribute('content', '#011627');
});

test('a touch is answered by the page rather than by the browser', async ({ page }) => {
  await page.goto('/');
  // No grey flash painted over whatever was tapped, including the entry rows,
  // which are not buttons.
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).webkitTapHighlightColor))
    .toBe('rgba(0, 0, 0, 0)');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).webkitTextSizeAdjust)).toBe('100%');

  // A control answers at once, and a long press on one takes hold of nothing.
  const control = page.getByRole('button', { name: 'Start focus timer', exact: true });
  await expect(control).toHaveCSS('touch-action', 'manipulation');
  await expect(control).toHaveCSS('user-select', 'none');
});

test('entry text stays selectable, because it is writing and not a control', async ({ page, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  await request.post('/api/notes', { data: { date: today, content: 'Text to take hold of' } });
  await page.goto('/');
  const row = page.getByRole('group', { name: 'Text to take hold of', exact: true });
  await expect(row).toBeVisible();
  expect(await row.evaluate(element => getComputedStyle(element).userSelect)).not.toBe('none');
});

test('a field is never small enough to zoom the page on a touch screen', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL: baseURL!, viewport: { width: 440, height: 700 }, hasTouch: true });
  const mobile = await context.newPage();
  try {
    await mobile.goto('/');
    expect(await mobile.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    // Under 16px, iOS zooms as the field takes focus and does not zoom back.
    // On a narrow screen the page controls live with the tags.
    await mobile.getByRole('tab', { name: 'tags', exact: true }).click();
    await mobile.getByRole('button', { name: 'Manage calendars', exact: true }).click();
    const field = mobile.getByRole('textbox').first();
    await expect(field).toBeVisible();
    expect(await field.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
  } finally {
    await context.close();
  }
});
