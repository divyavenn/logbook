import { expect, test, type Page } from './fixtures';

// Every pattern asked of navigator.vibrate, in order.
const record = async (page: Page) => page.addInitScript(() => {
  (window as typeof window & { felt: VibratePattern[] }).felt = [];
  Object.defineProperty(navigator, 'vibrate', { configurable: true, value: (pattern: VibratePattern) => {
    (window as typeof window & { felt: VibratePattern[] }).felt.push(pattern);
    return true;
  } });
});
const felt = (page: Page) => page.evaluate(() => (window as typeof window & { felt: VibratePattern[] }).felt);

test('only actions are felt: writing is not, a habit checked is, and the last one celebrates', async ({ page, request }) => {
  await record(page);
  await request.post('/api/notes', { data: { date: (await (await request.get('/api/journal?timezone=America/Los_Angeles')).json()).today, content: 'Somewhere to write' } });
  for (const name of ['Stretch', 'Read']) await request.post('/api/habits', { data: { name } });
  await page.goto('/');
  // Placing the caret and typing are not actions.
  await page.getByRole('group', { name: 'Somewhere to write', exact: true }).click();
  await page.keyboard.type(' more');
  await page.keyboard.press('Escape');
  expect(await felt(page)).toEqual([]);
  const habits = page.getByRole('list', { name: "Today's habits", exact: true });
  await habits.getByRole('button', { name: 'Complete Stretch', exact: true }).click();
  await expect.poll(() => felt(page)).toEqual([10]);
  // The last of the day is the larger moment.
  await habits.getByRole('button', { name: 'Complete Read', exact: true }).click();
  await expect.poll(() => felt(page)).toEqual([10, [10, 60, 10, 60, 24]]);
  // Taking a day back is felt softly.
  const done = page.getByTestId('log-scroll').getByRole('list', { name: /^Habits done on / });
  await done.getByRole('button', { name: 'Reopen Read', exact: true }).click();
  await expect.poll(() => felt(page)).toEqual([10, [10, 60, 10, 60, 24], 6]);
});

test('a task checked is felt', async ({ page, request }) => {
  await record(page);
  await request.post('/api/tasks', { data: { content: 'Water the plants' } });
  await page.goto('/');
  const tasks = page.getByRole('region', { name: 'to do', exact: true });
  await tasks.getByRole('button', { name: 'Complete Water the plants', exact: true }).click();
  await expect.poll(() => felt(page)).toEqual([10]);
});
