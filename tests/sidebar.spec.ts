import { expect, test } from './fixtures';

test('tag collection opens only in the outer half-margin, dims the page, and returns through logbook', async ({ page }) => {
  const tags = ['work', 'health', 'reading', 'ideas', 'garden', 'longer-project-name'];
  await page.route('**/api/journal?*', route => {
    const tag = new URL(route.request().url()).searchParams.get('tag');
    return route.fulfill({ json: {
      today: '2026-09-16', server_time: new Date().toISOString(), active_session: null, next_cursor: null, tag,
      tags: tags.map(name => ({ name, note_count: 1, task_count: 0 })), tasks: [],
      days: [{ date: '2026-09-16', focused_seconds: 0, longest_session_seconds: 0, session_count: 0,
        notes: tags.filter(name => !tag || name === tag).map((name, i) => ({ id: i + 1, content: `Notes about ${name}`, parent_id: null, position: i, tags: [name] })) }],
    } });
  });
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'New journal bullet', exact: true })).toBeFocused();
  const main = (await page.getByRole('main').boundingBox())!;
  const rightMargin = 1280 - main.x - main.width;
  expect(main.x).toBeGreaterThan(rightMargin);
  expect(main.x / rightMargin).toBeLessThan(1.2);
  const rail = page.getByRole('navigation', { name: 'Tags', exact: true });
  const home = rail.getByRole('button', { name: 'logbook', exact: true });
  const backdrop = page.getByTestId('tag-backdrop');
  const panel = page.getByTestId('tag-panel');
  await page.mouse.move(main.x * .75, 300);
  await expect(home).toBeHidden();
  await expect(backdrop).toHaveCSS('opacity', '0');
  await page.mouse.move(main.x * .25, 300);
  await expect(home).toBeVisible();
  await expect(panel).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  await expect(backdrop).toHaveCSS('opacity', '1');
  await expect(backdrop).toHaveCSS('backdrop-filter', 'blur(4px)');
  const all = rail.getByRole('button', { name: 'all', exact: true });
  const work = rail.getByRole('button', { name: '#work', exact: true });
  const health = rail.getByRole('button', { name: '#health', exact: true });
  await expect(all).toHaveAttribute('aria-pressed', 'true');
  await expect(work.locator('span')).toHaveCSS('translate', '0px -1px');
  const workBox = (await work.boundingBox())!, healthBox = (await health.boundingBox())!;
  expect(healthBox.y).toBe(workBox.y);
  expect(healthBox.x).toBeGreaterThan(workBox.x + workBox.width);
  await health.hover(); await expect(home).toBeVisible();
  const background = await health.evaluate(el => getComputedStyle(el).backgroundColor);
  await health.click();
  await expect(home).toBeHidden();
  await expect(page.getByRole('group', { name: 'Notes about work', exact: true })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Notes about health', exact: true })).toBeVisible();
  await page.mouse.move(1000, 500);
  await rail.hover();
  await expect(health).toHaveAttribute('aria-pressed', 'true');
  await expect(all).toHaveAttribute('aria-pressed', 'false');
  await expect(health).toHaveCSS('background-color', background);
  await all.click();
  await expect(page.getByRole('group', { name: 'Notes about work', exact: true })).toBeVisible();
  await page.mouse.move(1000, 500);
  await rail.focus(); await expect(home).toBeVisible();
  await page.keyboard.press('Escape'); await expect(home).toBeHidden();
  await rail.hover(); await expect(home).toBeVisible();
  await page.mouse.move(1000, 500); await expect(home).toBeHidden();
  await expect(panel).toHaveCSS('transform', 'matrix(1, 0, 0, 1, -18, 0)');
  await expect(backdrop).toHaveCSS('opacity', '0');
});

test('zoom-equivalent compact desktop widths preserve the left gutter and hover sidebar', async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 800 });
  await page.goto('/');
  await expect(page.getByRole('tablist', { name: 'Mobile views' })).toBeVisible();
  const main = (await page.getByRole('main').boundingBox())!;
  expect(main.x).toBe(48);
  expect(520 - main.x - main.width).toBe(16);

  const rail = page.getByRole('navigation', { name: 'Tags', exact: true });
  const home = rail.getByRole('button', { name: 'logbook', exact: true });
  expect((await rail.boundingBox())!.width).toBe(40);
  await page.mouse.move(12, 240);
  await expect(home).toBeVisible();
});
