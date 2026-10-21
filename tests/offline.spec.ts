import { expect, test } from './fixtures';

test('the logbook opens and takes edits with no network, then syncs', async ({ page, context, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  await request.post('/api/notes', { data: { date: today, content: 'Saved before going offline' } });
  await page.goto('/');
  await expect(page.getByRole('group', { name: 'Saved before going offline', exact: true })).toBeVisible();
  // The shell is only offline-ready once its service worker has precached it.
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return registration?.active?.state === 'activated';
  }, undefined, { timeout: 15000 });

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('group', { name: 'Saved before going offline', exact: true })).toBeVisible();

  const composer = page.getByRole('textbox', { name: 'New note', exact: true });
  await composer.fill('Written while offline');
  await composer.press('Enter');
  await expect(page.getByRole('group', { name: 'Written while offline', exact: true })).toBeVisible();
  // Nothing reached the server yet.
  const stored = async () => ((await (await request.get('/api/export')).json()).notes as Array<{ content: string }>)
    .map(note => note.content);
  expect(await stored()).not.toContain('Written while offline');

  await context.setOffline(false);
  await expect.poll(stored, { timeout: 20000 }).toContain('Written while offline');
  await page.reload();
  await expect(page.getByRole('group', { name: 'Written while offline', exact: true })).toBeVisible();
});
