import { expect, test, type Page } from './fixtures';

const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => { errors.set(page, []); page.on('pageerror', error => errors.get(page)!.push(error.message)); });
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]); });

const shift = (date: string, days: number) => {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() + days);
  return value.toLocaleDateString('en-CA');
};

test('days with nothing written fold away, open onto every date, each writable, and fold again', async ({ page, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  const early = shift(today, -6), focused = shift(today, -2);
  await request.post('/api/notes', { data: { date: early, content: 'Before the quiet' } });
  // A day with only focus on it has nothing written, and folds with the rest.
  await request.post('/api/sessions', { data: { started_at: new Date(`${focused}T12:00:00-08:00`).toISOString(), duration_seconds: 600 } });
  await page.goto('/');
  const log = page.getByTestId('log-scroll');
  await expect(log.getByRole('group', { name: 'Before the quiet', exact: true })).toBeVisible();
  // Between today and the written day, five dates fold away, the focused one among them.
  for (const offset of [-1, -2, -3, -4, -5]) await expect(log.locator(`[data-day="${shift(today, offset)}"]`)).toHaveCount(0);
  const mark = log.getByRole('button', { name: 'Show 5 days with nothing written', exact: true });
  // The run keeps the room of one day, and shows the ghost of a date, in the
  // date's own shape, only when pointed at.
  await expect(mark.locator('span')).toHaveCSS('opacity', '0');
  await mark.hover();
  await expect(mark.locator('span')).toHaveCSS('opacity', '1');
  await expect(mark.locator('span')).toHaveText('5 days');
  const ghost = await mark.locator('span').evaluate(el => { const s = getComputedStyle(el); return [s.fontFamily, s.fontSize, s.paddingTop, s.borderTopLeftRadius, s.borderTopStyle]; });
  const real = await log.locator(`[data-day="${early}"] time`).evaluate(el => { const s = getComputedStyle(el); return [s.fontFamily, s.fontSize, s.paddingTop, s.borderTopLeftRadius]; });
  expect(ghost).toEqual([...real, 'dashed']);
  await mark.click();
  // Opened, the ghost is gone; a chevron at the head of the run folds it.
  await expect(mark).toHaveCount(0);
  for (const offset of [-1, -2, -3, -4, -5]) await expect(log.locator(`[data-day="${shift(today, offset)}"]`)).toBeVisible();
  await expect(log.locator(`[data-day="${focused}"] [data-focus-total]`)).toBeAttached();
  // A date with nothing on it is written on by pressing it.
  const quiet = shift(today, -4);
  await log.getByRole('button', { name: `Write on ${quiet}`, exact: true }).click();
  const composer = log.locator(`[data-day="${quiet}"]`).getByRole('textbox', { name: 'New note', exact: true });
  await expect(composer).toBeFocused();
  await composer.pressSequentially('Written on a quiet day');
  await composer.press('Enter');
  await expect.poll(async () => {
    const data = await (await request.get('/api/export')).json();
    const note = data.notes.find((row: { content: string }) => row.content === 'Written on a quiet day');
    return note && data.days.find((row: { id: number }) => row.id === note.day_id)?.date;
  }).toBe(quiet);
  // The mark at the head of the run folds it again. The day now written on
  // stands on its own, between two smaller runs.
  await page.reload();
  await log.getByRole('button', { name: /^Show 3 days with nothing written$/ }).click();
  const hide = log.getByRole('button', { name: 'Hide 3 days with nothing written', exact: true });
  await expect(log.locator(`[data-day="${shift(today, -1)}"]`)).toBeVisible();
  await hide.click();
  await expect(log.locator(`[data-day="${shift(today, -1)}"]`)).toHaveCount(0);
});

test('writing into the middle of an open run splits it into two, each folding on its own', async ({ page, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  await request.post('/api/notes', { data: { date: shift(today, -6), content: 'Before the quiet' } });
  await page.goto('/');
  const log = page.getByTestId('log-scroll');
  await log.getByRole('button', { name: 'Show 5 days with nothing written', exact: true }).click();
  // The opened run is held by a spine, which is how it folds again.
  await expect(log.getByRole('button', { name: 'Hide 5 days with nothing written', exact: true })).toBeAttached();
  await request.post('/api/notes', { data: { date: shift(today, -4), content: 'In the middle' } });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(log.getByRole('group', { name: 'In the middle', exact: true })).toBeVisible();
  // Both halves are still open, each with a spine of its own.
  const newer = log.getByRole('button', { name: 'Hide 3 days with nothing written', exact: true });
  const older = log.getByRole('button', { name: 'Hide 1 day with nothing written', exact: true });
  await expect(newer).toBeAttached();
  await expect(older).toBeAttached();
  await older.click();
  await expect(log.locator(`[data-day="${shift(today, -5)}"]`)).toHaveCount(0);
  await expect(log.locator(`[data-day="${shift(today, -3)}"]`)).toBeVisible();
  await newer.click();
  await expect(log.locator(`[data-day="${shift(today, -3)}"]`)).toHaveCount(0);
});
