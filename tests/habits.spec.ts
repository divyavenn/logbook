import { expect, test, type Page } from './fixtures';

const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => { errors.set(page, []); page.on('pageerror', error => errors.get(page)!.push(error.message)); });
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]); });

const openStats = async (page: Page) => {
  await page.getByRole('navigation', { name: 'Tags', exact: true }).hover();
  await page.getByRole('button', { name: 'Open habits and focus', exact: true }).click();
  return page.getByRole('dialog', { name: 'Statistics', exact: true });
};
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
const dueHabits = (page: Page) => page.getByRole('list', { name: "Today's habits", exact: true });
const doneHabits = (page: Page) => page.getByTestId('log-scroll').getByRole('list', { name: `Habits done on ${today()}`, exact: true });
const addHabit = async (page: Page, name: string) =>
  (await page.request.post('/api/habits', { data: { name } })).json() as Promise<{ id: number }>;

test('a habit is drawn as a task, goes to the logbook when done, and comes back when unchecked', async ({ page, request }) => {
  await page.goto('/');
  let stats = await openStats(page);
  const field = stats.getByRole('textbox', { name: 'New habit', exact: true });
  await field.fill('Stretch');
  await field.press('Enter');
  // No streak, no figure.
  await expect(stats.getByRole('button', { name: 'Show Stretch chart, 0-day streak', exact: true })).toHaveText('');
  await page.keyboard.press('Escape');
  await page.mouse.move(1200, 900);

  await expect(dueHabits(page).getByText('Stretch', { exact: true })).toBeVisible();
  // It looks like a task but is not one, and its text is not an editor.
  expect((await (await request.get('/api/export')).json()).entries).toEqual([]);
  await dueHabits(page).getByText('Stretch', { exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Edit task' })).toHaveCount(0);

  await dueHabits(page).getByRole('button', { name: 'Complete Stretch', exact: true }).click();
  await expect(dueHabits(page)).toHaveCount(0);
  await expect(doneHabits(page).getByText('Stretch', { exact: true })).toBeVisible();
  // The pills sit beside the date, and show while the day is in hand: today,
  // until another day is being worked in.
  const pills = doneHabits(page);
  await page.mouse.move(1200, 20);
  await expect(pills).toHaveCSS('opacity', '1');
  const date = await page.locator(`[data-day="${today()}"] time`).boundingBox();
  await page.locator(`[data-day="${today()}"] time`).hover();
  await expect(pills).toHaveCSS('opacity', '1');
  const pill = await pills.locator('li').first().boundingBox();
  expect(Math.abs((pill!.y + pill!.height / 2) - (date!.y + date!.height / 2))).toBeLessThan(3);
  expect(pill!.x).toBeGreaterThan(date!.x + date!.width);
  await page.mouse.move(1200, 20);
  await pills.getByRole('button', { name: 'Reopen Stretch' }).focus();
  await expect(pills).toHaveCSS('opacity', '1');
  await pills.getByRole('button', { name: 'Reopen Stretch' }).blur();

  stats = await openStats(page);
  await expect(stats.getByRole('button', { name: 'Show Stretch chart, 1-day streak', exact: true })).toBeAttached();
  // A habit's name shows its chart.
  await stats.getByRole('textbox', { name: 'Rename Stretch', exact: true }).click();
  await expect(stats.getByRole('group', { name: 'Stretch: done 1 of the last 30 days.' }).locator(`[data-date="${today()}"]`)).toHaveAttribute('data-level', '4');
  await page.keyboard.press('Escape');
  await page.mouse.move(1200, 900);

  await doneHabits(page).getByRole('button', { name: 'Reopen Stretch', exact: true }).click();
  await expect(doneHabits(page)).toHaveCount(0);
  await expect(dueHabits(page).getByText('Stretch', { exact: true })).toBeVisible();
});

test('a habit given up leaves the list and tracker, and its days stay in the logbook', async ({ page }) => {
  const habit = await addHabit(page, 'Stretch');
  await page.request.put(`/api/habits/${habit.id}/days/${today()}?timezone=America/Los_Angeles`);
  await page.goto('/');
  const stats = await openStats(page);
  await stats.getByRole('button', { name: 'Remove Stretch', exact: true }).click();
  await stats.getByRole('button', { name: 'Remove Stretch for good', exact: true }).click();
  await expect(stats.getByRole('textbox', { name: 'Rename Stretch', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.mouse.move(1200, 900);
  await expect(dueHabits(page)).toHaveCount(0);
  // The day it was done stands, and cannot be taken back.
  await expect(doneHabits(page).getByRole('button', { name: 'Stretch, done', exact: true })).toBeDisabled();
});

test('Alt and an arrow move a habit, and the order is kept', async ({ page }) => {
  for (const name of ['Stretch', 'Read', 'Walk']) await addHabit(page, name);
  await page.goto('/');
  const list = dueHabits(page);
  const names = () => list.locator('li').allInnerTexts();
  await expect.poll(names).toEqual(['Stretch', 'Read', 'Walk']);
  await list.getByRole('button', { name: 'Complete Walk', exact: true }).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(names).toEqual(['Walk', 'Stretch', 'Read']);
  await page.reload();
  await expect.poll(names).toEqual(['Walk', 'Stretch', 'Read']);
});

test('the panel has a day: a square selects it, and pressing it again toggles the habit', async ({ page }) => {
  await addHabit(page, 'Stretch');
  const yesterday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const named = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toLowerCase();
  const done = async () => (await (await page.request.get('/api/habits')).json())[0].done;
  await page.goto('/');
  const stats = await openStats(page);
  const heading = (date: string) => stats.getByRole('button', { name: `Open ${named(date)} in the logbook`, exact: true });
  // The panel opens on today.
  await expect(heading(today())).toBeVisible();
  await stats.getByRole('textbox', { name: 'Rename Stretch', exact: true }).click();
  const chart = stats.getByRole('group', { name: /^Stretch: / });
  const square = chart.locator(`[data-date="${yesterday}"]`);
  // The first press makes yesterday the panel's day; the second marks it done.
  await square.click();
  await expect(square).toHaveAttribute('aria-current', 'date');
  await expect(square).toHaveAttribute('aria-pressed', 'false');
  await page.mouse.move(5, 5);
  await expect(heading(yesterday)).toBeVisible();
  await square.click();
  await expect(square).toHaveAttribute('aria-pressed', 'true');
  const streak = stats.getByRole('button', { name: 'Show Stretch chart, 1-day streak', exact: true });
  await expect(streak).toHaveText('1');
  await expect(streak.locator('svg')).toBeAttached();
  await expect.poll(done).toEqual([yesterday]);
  // Hovering another day heads the panel with it for as long as it is hovered.
  await chart.locator(`[data-date="${today()}"]`).hover();
  await expect(heading(today())).toBeVisible();
  await page.mouse.move(5, 5);
  await expect(heading(yesterday)).toBeVisible();
  await expect(stats.getByRole('list', { name: `Habits done on ${yesterday}` }).getByText('Stretch', { exact: true })).toBeVisible();
  await expect(stats.getByText(/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)$/)).toHaveCount(0);
  // From the keyboard: the arrows move the day and Enter marks it.
  await square.focus();
  await page.keyboard.press('ArrowRight');
  await expect(chart.locator(`[data-date="${today()}"]`)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(stats.getByRole('button', { name: 'Show Stretch chart, 2-day streak', exact: true })).toBeAttached();
  expect(await chart.locator('button[data-date]').evaluateAll((cells, end) => cells.every(cell => (cell as HTMLElement).dataset.date! <= end), today())).toBe(true);
  // A pill in the heading takes its day back, as one in the logbook does.
  await page.mouse.move(5, 5);
  await stats.getByRole('button', { name: `Reopen Stretch on ${today()}`, exact: true }).click();
  await expect.poll(done).toEqual([yesterday]);
  // The focus chart has nothing to toggle: a second press only keeps the day.
  await stats.getByRole('button', { name: /^Show focus chart/ }).click();
  const focus = stats.getByRole('group', { name: /^Focus: / });
  await focus.locator(`[data-date="${yesterday}"]`).click();
  await focus.locator(`[data-date="${yesterday}"]`).click();
  await expect.poll(done).toEqual([yesterday]);
  // The heading leads to its day in the logbook.
  await page.mouse.move(5, 5);
  await heading(yesterday).click();
  await expect(stats).toBeHidden();
  await expect(page.locator(`[data-day="${yesterday}"]`)).toBeInViewport();
  await expect(dueHabits(page).getByText('Stretch', { exact: true })).toBeVisible();
});

test('renaming a habit renames it on the list', async ({ page }) => {
  await addHabit(page, 'Read');
  await page.goto('/');
  await expect(dueHabits(page).getByText('Read', { exact: true })).toBeVisible();
  const stats = await openStats(page);
  const name = stats.getByRole('textbox', { name: 'Rename Read', exact: true });
  await name.fill('Read a chapter');
  await name.press('Enter');
  await expect(stats.getByRole('textbox', { name: 'Rename Read a chapter', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dueHabits(page).getByText('Read a chapter', { exact: true })).toBeVisible();
});

test('focus reads as its weekly average, and a day shows its time as soon as it is hovered', async ({ page, request }) => {
  // Midday two days ago: inside the past week, and clear of midnight whenever the test runs.
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(twoDaysAgo);
  const started = new Date(`${day}T12:00:00-08:00`);
  await request.post('/api/sessions', { data: { started_at: started.toISOString(), duration_seconds: 70 * 60 } });
  await page.goto('/');
  const stats = await openStats(page);
  await expect(stats.getByRole('button', { name: 'Show focus chart, 0h 10m a day this week', exact: true })).toBeVisible();
  const chart = stats.getByRole('group', { name: /^Focus: 1 of the last \d+ days\.$/ });
  const cell = chart.locator(`[data-date="${day}"]`);
  await expect(cell).toHaveAttribute('data-level', '1');
  await cell.hover();
  await expect(stats.getByText('1h 10m', { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(stats.getByText(/^[a-z]{3} \d{1,2}$/)).toBeVisible();
  // With room across, the chart stands beside the list: this week heads it,
  // and the earlier weeks wait below.
  const layout = await chart.evaluate(frame => {
    const cells = [...frame.querySelectorAll<HTMLElement>('[data-date]')];
    const viewport = frame.parentElement!;
    const list = document.querySelector('[aria-label="Focus and habits"]')!.getBoundingClientRect();
    return { top: cells.slice(0, 7).map(cell => cell.dataset.date!), rows: cells.length / 7,
      scrolls: viewport.scrollHeight > viewport.clientHeight, beside: frame.getBoundingClientRect().left > list.right };
  });
  expect(layout.top).toContain(day);
  expect(layout.rows).toBe(26);
  expect(layout).toMatchObject({ scrolls: true, beside: true });
});

test('in a narrow window the chart lies beneath the list and opens on this week', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 900 });
  await page.goto('/');
  await page.getByRole('tab', { name: 'tags', exact: true }).click();
  await page.getByRole('button', { name: 'Open habits and focus', exact: true }).click();
  const stats = page.getByRole('dialog', { name: 'Statistics', exact: true });
  const chart = stats.getByRole('group', { name: /^Focus: / });
  await expect(chart).toBeVisible();
  const layout = await chart.evaluate(frame => {
    const viewport = frame.parentElement!;
    const list = document.querySelector('[aria-label="Focus and habits"]')!.getBoundingClientRect();
    return { below: frame.getBoundingClientRect().top > list.bottom, scrolls: viewport.scrollWidth > viewport.clientWidth,
      atEnd: Math.abs(viewport.scrollLeft + viewport.clientWidth - viewport.scrollWidth) <= 1 };
  });
  expect(layout).toEqual({ below: true, scrolls: true, atEnd: true });
  await expect(chart.locator(`[data-date="${today()}"]`)).toBeInViewport();
});
