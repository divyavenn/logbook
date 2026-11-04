import { expect, test, type Page } from './fixtures';

const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => { errors.set(page, []); page.on('pageerror', error => errors.get(page)!.push(error.message)); });
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]); });

const shift = (date: string, days: number) => {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() + days);
  return value.toLocaleDateString('en-CA');
};

test('days with nothing written fold into a line that opens onto every date, each one writable', async ({ page, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  const early = shift(today, -6), focused = shift(today, -2);
  await request.post('/api/notes', { data: { date: early, content: 'Before the quiet' } });
  // A day with focus has something on it, and stands among the written ones.
  await request.post('/api/sessions', { data: { started_at: new Date(`${focused}T12:00:00-08:00`).toISOString(), duration_seconds: 600 } });
  await page.goto('/');
  const log = page.getByTestId('log-scroll');
  await expect(log.getByRole('group', { name: 'Before the quiet', exact: true })).toBeVisible();
  await expect(log.locator(`[data-day="${focused}"]`)).toBeVisible();
  // Between the focused day and the written one, three dates fold away.
  for (const offset of [-3, -4, -5]) await expect(log.locator(`[data-day="${shift(today, offset)}"]`)).toHaveCount(0);
  const line = log.getByRole('button', { name: 'Show 3 days with nothing written', exact: true });
  await expect(line).toBeVisible();
  await line.click();
  // Opened, the line gives way to the dates it held.
  await expect(line).toHaveCount(0);
  for (const offset of [-3, -4, -5]) await expect(log.locator(`[data-day="${shift(today, offset)}"]`)).toBeVisible();
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
});
