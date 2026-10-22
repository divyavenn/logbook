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
