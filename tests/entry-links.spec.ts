import { test, expect } from './fixtures';

const LINK = /^http:\/\/[^/]+\/#e\/notes\/\d+\/[0-9a-f]{16}$/;

// Holding an entry: the gesture that lifts it off the page, which is what the
// link affordances hang from.
const hold = async (page: import('./fixtures').Page, name: string) => {
  await page.getByRole('group', { name, exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Edit note', exact: true });
  const box = (await editor.boundingBox())!;
  await editor.dblclick({ position: { x: box.width - 5, y: 12 } });
  await expect(editor.locator('xpath=ancestor::li[1]')).toHaveAttribute('data-gesture-selected', 'true');
  return editor;
};

test('a held entry copies a link to itself, by shortcut and by glyph', async ({ page, context, request }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  await request.post('/api/notes', { data: { date: today, content: 'Worth pointing at' } });
  await page.goto('/');
  await hold(page, 'Worth pointing at');
  await page.keyboard.press('Meta+Shift+k');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(LINK);
  const copied = await page.evaluate(() => navigator.clipboard.readText());

  // The glyph is offered only while the entry is held, and copies the same
  // link. The press must not be read as the start of a drag.
  await page.evaluate(() => navigator.clipboard.writeText('cleared'));
  const glyph = page.locator('li[data-gesture-selected] [data-copy-link]');
  await expect(glyph).toBeVisible();
  // Held, the entry is the open editor, so the row itself is what is measured.
  const row = page.locator('li[data-gesture-selected]');
  const before = (await row.boundingBox())!;
  await glyph.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(copied);
  const after = (await row.boundingBox())!;
  expect(Math.abs(after.x - before.x)).toBeLessThan(2);
});

test('a copied link pasted into an entry reads as a glimpse of it', async ({ page, context, request }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  // The tag leads the text, so a glimpse that kept tags would begin with it.
  await request.post('/api/notes', { data: { date: today, content: '#filed Pointed at from a later note', tags: ['filed'] } });
  await page.goto('/');
  await hold(page, '#filed Pointed at from a later note');
  await page.keyboard.press('Meta+Shift+k');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(LINK);

  // Pasted into another entry it is a bare link, which is what reads as a
  // glimpse: a few words of the entry in a pill, and no tag among them.
  await page.keyboard.press('Escape');
  const composer = page.getByRole('textbox', { name: 'New note', exact: true });
  await composer.click();
  await composer.pressSequentially('as written in ');
  await page.keyboard.press('Meta+v');
  await composer.press('Enter');
  const reference = page.getByRole('group', { name: /^as written in/ }).locator('a[data-entry-link]');
  await expect(reference).toHaveText('Pointed at from a');
  await expect(reference).toHaveCSS('border-radius', '999px');
  await expect(reference.locator('span')).toHaveCSS('mask-image', /linear-gradient/);
});

test('the link glyph is offered only for a held entry', async ({ page, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  await request.post('/api/notes', { data: { date: today, content: 'Not held' } });
  await page.goto('/');
  await expect(page.getByRole('group', { name: 'Not held', exact: true })).toBeVisible();
  await expect(page.locator('[data-copy-link]')).toHaveCount(0);
});

test('a link in an entry opens the day it names and lands on it', async ({ page, context, request }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  const old = await (await request.post('/api/notes', { data: { date: '2010-01-01', content: 'Written long ago and far away' } })).json();
  // The logbook opens on its most recent fortnight, so these put that day well
  // behind the page the link has to reach past.
  for (let day = 2; day <= 17; day++) {
    await request.post('/api/notes', { data: { date: `2010-01-${String(day).padStart(2, '0')}`, content: `Later, on the ${day}th` } });
  }
  await request.post('/api/notes', { data: { date: today, content: 'Today, filed', tags: ['filed'] } });
  const signature = (await (await request.get(`/api/entries/notes/${old.id}`)).json()).signature;
  const url = `/#e/notes/${old.id}/${signature}`;
  await page.goto('/');

  // A bare link reads as the opening of what it points at, once that entry is
  // on the page to be read from.
  const composer = page.getByRole('textbox', { name: 'New note', exact: true });
  await composer.click();
  await composer.pressSequentially(`see ${new URL(url, page.url()).href} `);
  await composer.press('Enter');
  // A glimpse of what it points at, in a pill of its own: a few words, with no
  // tags among them.
  const reference = page.getByRole('group', { name: /^see/ }).locator('a[data-entry-link]');
  await expect(reference).toHaveText('Written long ago and');
  await expect(reference).toHaveCSS('border-radius', '999px');
  await expect(reference).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(reference.locator('span')).toHaveCSS('mask-image', /linear-gradient/);

  // Following it loads the day it is filed under, which was never on screen.
  await expect(page.getByRole('group', { name: 'Written long ago and far away', exact: true })).toHaveCount(0);
  await reference.click();
  const arrived = page.getByRole('group', { name: 'Written long ago and far away', exact: true });
  await expect(arrived).toBeVisible();
  await expect(arrived).toBeInViewport();
  // It arrives in the whole logbook, so the entry can be edited where it sits.
  await expect(page.getByRole('group', { name: 'Today, filed', exact: true })).toBeVisible();
});

test('a link opened as an address lands on its entry and leaves the address clean', async ({ page, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  const note = await (await request.post('/api/notes', { data: { date: '2011-02-10', content: 'Arrived by address' } })).json();
  // A logbook long enough to scroll, with page above the entry and page below
  // it, so coming to rest at the top is something it can actually do.
  for (let day = 1; day <= 12; day++) {
    const date = `2011-02-${String(day).padStart(2, '0')}`;
    for (let line = 0; line < 3; line++) await request.post('/api/notes', { data: { date, content: `Written on ${date}, line ${line}` } });
  }
  await request.post('/api/notes', { data: { date: today, content: 'Today as usual' } });
  const signature = (await (await request.get(`/api/entries/notes/${note.id}`)).json()).signature;
  await page.goto(`/#e/notes/${note.id}/${signature}`);
  const arrived = page.getByRole('group', { name: 'Arrived by address', exact: true });
  await expect(arrived).toBeVisible();
  // The page travels there rather than cutting to it, so the log is caught
  // somewhere between where it was and where it is going.
  const sampled: number[] = [];
  for (let sample = 0; sample < 24; sample++) {
    sampled.push(await page.getByTestId('log-scroll').evaluate(pane => pane.scrollTop));
    await page.waitForTimeout(40);
  }
  const settled = sampled.at(-1)!;
  expect(settled).toBeGreaterThan(0);
  expect(sampled.some(top => top > 0 && top < settled)).toBe(true);
  // The entry led to leads: it comes to rest at the top of the log, just clear
  // of the wash, rather than in the middle of it.
  await expect(arrived).toBeInViewport();
  await expect.poll(async () => {
    const row = (await arrived.boundingBox())!;
    const pane = (await page.getByTestId('log-scroll').boundingBox())!;
    return Math.round(row.y - pane.y);
  }).toBeLessThan(44);
  // The arrival has happened, so a reload is a reload and not the same trip.
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('');
});

test('a label the writer chose is left alone, and the editor follows the link in place', async ({ page, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  const note = await (await request.post('/api/notes', { data: { date: today, content: 'The entry pointed at' } })).json();
  const signature = (await (await request.get(`/api/entries/notes/${note.id}`)).json()).signature;
  await page.addInitScript(() => {
    (window as unknown as { __opened: string[] }).__opened = [];
    window.open = ((url: string) => { (window as unknown as { __opened: string[] }).__opened.push(String(url)); return null; }) as typeof window.open;
  });
  // Same origin as the page under test, whatever port it was given.
  await page.goto('/');
  const url = `${new URL(page.url()).origin}/#e/notes/${note.id}/${signature}`;
  await request.post('/api/notes', { data: { date: today, content: `look back at [the one before](${url})` } });
  await page.reload();
  const reference = page.getByRole('group', { name: /look back at/ }).locator('a[data-entry-link]');
  await expect(reference).toHaveText('the one before');

  // Clicked inside the editor it is followed here too, not opened in a tab.
  await page.getByRole('group', { name: /look back at/ }).click();
  const editor = page.getByRole('textbox', { name: 'Edit note', exact: true });
  await editor.locator('a').click();
  const arrived = page.getByRole('group', { name: 'The entry pointed at', exact: true });
  await expect(arrived).toBeVisible();
  await expect(arrived).toBeInViewport();
  expect(await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).toEqual([]);
});

test('a link only reads the entry it signs, and a forged one reads nothing', async ({ request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  const parent = await (await request.post('/api/notes', { data: { date: today, content: 'The shared one', tags: ['shared'] } })).json();
  await request.post('/api/notes', { data: { date: today, content: 'Beneath it', parent_id: parent.id } });
  await request.post('/api/notes', { data: { date: today, content: 'A neighbour, not shared' } });
  const signature: string = parent.signature;
  expect(signature).toMatch(/^[0-9a-f]{16}$/);

  const shared = await request.get(`/api/share/notes/${parent.id}/${signature}`);
  expect(shared.status()).toBe(200);
  const body = await shared.json();
  expect(body.entry.content).toBe('The shared one');
  expect(body.children.map((child: { content: string }) => child.content)).toEqual(['Beneath it']);
  expect(body.date).toBe(today);
  // The day around it is not on offer, nor the shape of the rest of the page.
  const text = JSON.stringify(body);
  expect(text).not.toContain('A neighbour, not shared');
  expect(body).not.toHaveProperty('tasks');
  expect(body).not.toHaveProperty('tags');
  expect(body.entry).not.toHaveProperty('day_id');

  const forged = signature.replace(/^./, character => character === '0' ? '1' : '0');
  const refused = await request.get(`/api/share/notes/${parent.id}/${forged}`);
  expect(refused.status()).toBe(404);
  expect(await refused.text()).not.toContain('The shared one');
  expect((await request.get(`/api/share/notes/${parent.id}/deadbeefdeadbeef`)).status()).toBe(404);
  // Signed for the wrong kind, the same id says nothing either.
  expect((await request.get(`/api/share/tasks/${parent.id}/${signature}`)).status()).toBe(404);
});
