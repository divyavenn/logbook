import { expect, test } from './fixtures';

test('a return visit shows the logbook before the network answers', async ({ page, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  await request.post('/api/notes', { data: { date: today, content: 'Seen on the last visit' } });
  const entry = page.getByRole('group', { name: 'Seen on the last visit', exact: true });
  await page.goto('/');
  await expect(entry).toBeVisible();

  // Hold every request open: nothing below may wait on one.
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  for (const route of ['**/api/journal?*', '**/api/auth/status*']) {
    await page.route(route, async handler => { await held; await handler.continue(); });
  }
  await page.reload();
  await expect(entry).toBeVisible({ timeout: 4000 });
  await expect(page.getByRole('dialog', { name: 'Password required', exact: true })).toHaveCount(0);
  // And the held answers still land, replacing what was painted from memory.
  release();
  await expect(entry).toBeVisible();
});

test("today opens before the earlier days have been asked for", async ({ page, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  await request.post('/api/notes', { data: { date: today, content: 'Written today' } });
  await request.post('/api/notes', { data: { date: '2026-09-01', content: 'Written long ago' } });
  // The page asks for today on its own, and for the rest of the logbook
  // behind it. Holding the second answer leaves today standing by itself.
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const asked: string[] = [];
  await page.route('**/api/journal?*', async handler => {
    const limit = new URL(handler.request().url()).searchParams.get('limit');
    asked.push(limit ?? 'none');
    if (limit !== '1') await held;
    await handler.continue();
  });
  await page.goto('/');
  const todayEntry = page.getByRole('group', { name: 'Written today', exact: true });
  const older = page.getByRole('group', { name: 'Written long ago', exact: true });
  await expect(todayEntry).toBeVisible({ timeout: 4000 });
  // The caret is in today's composer while the rest is still on its way.
  await expect(page.getByRole('textbox', { name: 'New note', exact: true })).toBeFocused();
  await expect(older).toHaveCount(0);
  expect(asked[0]).toBe('1');
  release();
  await expect(older).toBeVisible();
});
