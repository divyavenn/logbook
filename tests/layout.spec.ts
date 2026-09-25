import { expect, test } from './fixtures';
import AxeBuilder from '@axe-core/playwright';

const today = '2026-09-17';
test.beforeEach(async ({ page }) => {
  await page.route('**/api/journal?*', route => route.fulfill({ json: {
    today, server_time: new Date().toISOString(), active_session: null, next_cursor: null, tags: [], tag: null,
    tasks: [{ id: 9001, content: 'First to-do', tags: [], parent_id: null, position: 0 }],
    days: [
      { date: today, focused_seconds: 0, notes: Array.from({ length: 30 }, (_, i) => ({ id: 9100 + i, content: `Current note ${i}`, tags: [], parent_id: null, position: i })) },
      { date: '2026-09-16', focused_seconds: 0, notes: [{ id: 9200, content: 'Older note', tags: [], parent_id: null, position: 0 }] },
    ],
  } }));
});

test('global timer stays fixed at the top right while to-dos stack above the log', async ({ page }) => {
  await page.goto('/');
  const timer = page.getByRole('button', { name: 'Start focus timer', exact: true });
  const readout = page.getByTestId('compact-timer-time');
  const task = page.getByRole('group', { name: 'First to-do', exact: true });
  const note = page.getByRole('group', { name: 'Current note 0', exact: true });
  for (const width of [1440, 1280, 1024, 900, 760, 641]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByTestId('log-scroll').evaluate(element => { element.scrollTop = 0; });
    await expect(page.getByRole('tablist', { name: 'Mobile views' })).toHaveCount(0);
    const [button, time, first, text] = await Promise.all([
      timer.boundingBox(), readout.boundingBox(), task.boundingBox(), note.boundingBox(),
    ]);
    expect(button!.width).toBe(44);
    expect(button!.height).toBe(44);
    expect(button!.x + button!.width).toBe(width - 24);
    expect(button!.y).toBe(20);
    expect(time!.x + time!.width).toBeLessThan(button!.x);
    expect(first!.y + first!.height).toBeLessThan(text!.y);
    await expect(page.getByRole('group', { name: 'Page controls' })).toBeHidden();
    await page.getByTestId('log-scroll').evaluate(el => { el.scrollTop = el.scrollHeight; });
    const scrolledTimer = (await timer.boundingBox())!;
    expect(scrolledTimer).toEqual(button);
    await page.getByTestId('log-scroll').evaluate(el => { el.scrollTop = 0; });
  }
  await page.screenshot({ path: '/tmp/still-layout-desktop.png' });
});

test('stacked to-dos keep a generous creation area and wrap within the document', async ({ page }) => {
  await page.unroute('**/api/journal?*');
  let tasks: Array<{ id: number; content: string; tags: string[]; parent_id: null; position: number }> = [];
  await page.route('**/api/journal?*', route => route.fulfill({ json: {
    today, server_time: new Date().toISOString(), active_session: null, next_cursor: null, tags: [], tag: null, tasks,
    days: [{ date: today, focused_seconds: 0, notes: [{ id: 9300, content: 'Width reference', tags: [], parent_id: null, position: 0 }] }],
  } }));
  await page.goto('/');
  const emptyArea = page.getByRole('button', { name: 'Add to-do', exact: true });
  await expect(emptyArea).toBeVisible();
  expect((await emptyArea.boundingBox())!.height).toBeGreaterThan(80);
  await expect(page.getByRole('textbox', { name: 'New to-do', exact: true })).toHaveCount(0);
  await emptyArea.click({ position: { x: 20, y: (await emptyArea.boundingBox())!.height - 10 } });
  await expect(page.getByRole('textbox', { name: 'New to-do', exact: true })).toBeFocused();

  tasks = [{ id: 9301, content: 'A deliberately very long to-do entry that keeps going until it has to wrap before reaching the timer at the established outer edge of the document', tags: [], parent_id: null, position: 0 }];
  await page.reload();
  const task = (await page.getByRole('group', { name: tasks[0].content, exact: true }).boundingBox())!;
  const main = (await page.getByRole('main').boundingBox())!;
  expect(task.height).toBeGreaterThan(28);
  expect(task.x).toBeGreaterThanOrEqual(main.x);
  expect(task.x + task.width).toBeLessThanOrEqual(main.x + main.width);

  tasks = [{ id: 9302, content: 'A reasonably long introductory phrase pneumonoultramicroscopicsilicovolcanoconiosisextended', tags: [], parent_id: null, position: 0 }];
  await page.reload();
  const wordTask = (await page.getByRole('group', { name: tasks[0].content, exact: true }).boundingBox())!;
  expect(wordTask.height).toBeGreaterThan(28);
  expect(wordTask.x + wordTask.width).toBeLessThanOrEqual(main.x + main.width);
});

test('narrow or short viewports use three swipe panes with the timer always visible', async ({ page }) => {
  await page.goto('/');
  const timer = page.getByRole('button', { name: 'Start focus timer', exact: true });
  const timerReadout = page.getByTestId('compact-timer-time');
  for (const size of [
    { width: 640, height: 800 }, { width: 440, height: 700 }, { width: 260, height: 700 },
    { width: 440, height: 400 }, { width: 260, height: 180 }, { width: 1000, height: 400 },
  ]) {
    await page.setViewportSize(size);
    const tabs = page.getByRole('tablist', { name: 'Mobile views' });
    await expect(tabs).toBeVisible();
    await expect(tabs.getByRole('tab')).toHaveText(['to do', 'log', 'tags']);
    await expect(page.getByRole('tab', { name: 'log', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(timer).toBeInViewport();
    await expect(timerReadout).toHaveText('00:00:00');
    const [activeDot, timerBox] = await Promise.all([
      page.getByRole('tab', { name: 'log', exact: true }).boundingBox(), timer.boundingBox(),
    ]);
    expect(activeDot!.y + activeDot!.height / 2).toBeCloseTo(timerBox!.y + timerBox!.height / 2, 0);
    await expect(page.getByRole('tab', { name: 'log', exact: true })).toHaveCSS('font-size', '0px');
    await expect(page.getByRole('navigation', { name: 'Tags' })).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Page controls' })).toBeHidden();
    const pager = page.getByTestId('mobile-pager');
    await expect(pager).toHaveCSS('scrollbar-width', 'none');
    await expect(pager).toHaveCSS('scroll-snap-type', 'x mandatory');
    await expect(pager).toHaveCSS('overscroll-behavior-x', 'none');
    await expect(pager.locator(':scope > section').first()).toHaveCSS('scroll-snap-stop', 'always');
    await expect(page.getByTestId('log-scroll')).toHaveCSS('scrollbar-width', 'none');
    const paneGeometry = await pager.evaluate(element => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      panes: [...element.children].map(child => ({ clientWidth: (child as HTMLElement).clientWidth, scrollWidth: (child as HTMLElement).scrollWidth })),
    }));
    expect(paneGeometry.scrollWidth).toBe(paneGeometry.clientWidth * 3);
    expect(paneGeometry.panes.every(pane => pane.clientWidth === paneGeometry.clientWidth && pane.scrollWidth <= pane.clientWidth), JSON.stringify(paneGeometry)).toBe(true);
    if (size.width <= 640) {
      const main = (await page.getByRole('main').boundingBox())!;
      expect(main.x).toBe(24);
      expect(size.width - main.x - main.width).toBe(16);
    }
    await page.getByRole('tab', { name: 'tags', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'tags', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('group', { name: 'Page controls' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'all', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'to do', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'to do', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('group', { name: 'First to-do', exact: true })).toBeInViewport();
    expect((await page.getByRole('group', { name: 'First to-do', exact: true }).boundingBox())!.height).toBeLessThanOrEqual(40);
    await page.getByRole('tab', { name: 'log', exact: true }).click();
    await page.getByTestId('log-scroll').evaluate(element => { element.scrollTop = 0; });
    await expect(page.getByRole('group', { name: 'Current note 0', exact: true })).toBeInViewport();
    await expect(page.getByRole('group', { name: 'Older note', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(size.width);
    if (size.width === 440 && size.height === 700) await page.screenshot({ path: '/tmp/still-layout-tall-thin.png' });
    if (size.width === 440 && size.height === 400) await page.screenshot({ path: '/tmp/still-layout-short-thin.png' });
  }
  await page.setViewportSize({ width: 440, height: 700 });
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
});

test('a mobile keyboard height change keeps the active editor mounted and stable', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL: baseURL!, viewport: { width: 440, height: 700 }, hasTouch: true });
  const mobile = await context.newPage();
  try {
    await mobile.goto('/');
    expect(await mobile.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    const composer = mobile.getByRole('textbox', { name: 'New journal bullet', exact: true });
    await expect(composer).toBeFocused();
    await composer.fill('Mobile typing');

    await mobile.setViewportSize({ width: 440, height: 360 });
    await expect(mobile.getByRole('tablist', { name: 'Mobile views' })).toBeVisible();
    await expect(composer).toBeFocused();
    await composer.pressSequentially(' stays put');
    await expect(composer).toHaveText('Mobile typing stays put');

    await mobile.setViewportSize({ width: 440, height: 700 });
    await composer.press('Enter');
    await expect(mobile.getByRole('group', { name: 'Mobile typing stays put', exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test('a touch swipe always advances the narrow pager by one tab', async ({ page }) => {
  await page.setViewportSize({ width: 440, height: 700 });
  await page.goto('/');
  const tabs = page.getByRole('tablist', { name: 'Mobile views' });
  const pager = page.getByTestId('mobile-pager');
  await expect(tabs.getByRole('tab', { name: 'log', exact: true })).toHaveAttribute('aria-selected', 'true');
  const box = (await pager.boundingBox())!;
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const swipe = async (from: number, to: number) => {
    const y = box.y + Math.min(160, box.height / 2);
    const point = (x: number) => ({ x, y, id: 0, radiusX: 1, radiusY: 1, force: 1 });
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(from)] });
    for (let step = 1; step <= 5; step++) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(from + (to - from) * step / 5)] });
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  await swipe(box.x + box.width * .82, box.x + box.width * .18);
  await expect(tabs.getByRole('tab', { name: 'tags', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(await pager.evaluate(element => element.scrollLeft)).toBeCloseTo(box.width * 2, 0);
  await swipe(box.x + box.width * .18, box.x + box.width * .82);
  await expect(tabs.getByRole('tab', { name: 'log', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(await pager.evaluate(element => element.scrollLeft)).toBeCloseTo(box.width, 0);
});

test('swipe log loads earlier dates infinitely and preserves its active tag filter', async ({ page }) => {
  await page.unroute('**/api/journal?*');
  const requests: URL[] = [];
  await page.route('**/api/journal?*', route => {
    const url = new URL(route.request().url()); requests.push(url);
    const tag = url.searchParams.get('tag');
    const before = url.searchParams.get('before');
    return route.fulfill({ json: {
      today, server_time: new Date().toISOString(), active_session: null,
      tags: [{ name: 'work', note_count: 26, task_count: 0 }], tag, tasks: [],
      next_cursor: before ? null : '2026-09-16',
      days: before
        ? [{ date: '2026-09-01', focused_seconds: 0, notes: [{ id: 9800, content: 'Infinitely older work note', tags: ['work'], parent_id: null, position: 0 }] }]
        : [{ date: today, focused_seconds: 0, notes: Array.from({ length: 25 }, (_, index) => ({ id: 9700 + index, content: `Recent work note ${index}`, tags: ['work'], parent_id: null, position: index })) }],
    } });
  });
  await page.setViewportSize({ width: 440, height: 400 });
  await page.goto('/');
  await page.getByRole('tab', { name: 'tags', exact: true }).click();
  await page.getByRole('button', { name: '#work', exact: true }).click();
  await expect(page.getByRole('button', { name: '#work', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('tab', { name: 'log', exact: true }).click();
  await page.getByTestId('log-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(page.getByRole('group', { name: 'Infinitely older work note', exact: true })).toBeVisible();
  expect(requests.some(url => url.searchParams.has('before') && url.searchParams.get('tag') === 'work')).toBe(true);
});

test('journal opacity wash remains above the first date at the top of the viewport', async ({ page }) => {
  await page.goto('/');
  const journal = page.getByTestId('log-scroll');
  const wash = page.getByTestId('log-top-ink-wash');
  await journal.evaluate(element => { element.scrollTop = 0; });
  await expect(wash).toHaveCSS('opacity', '1');
  await expect(wash).toHaveCSS('backdrop-filter', 'none');
  const firstDate = page.getByRole('button', { name: `Focus sessions for ${today}`, exact: true });
  const [topDateBox, topWashBox] = await Promise.all([firstDate.boundingBox(), wash.boundingBox()]);
  expect(topDateBox!.y).toBeGreaterThanOrEqual(topWashBox!.y + topWashBox!.height);
  await journal.evaluate(el => { el.scrollTop = 80; });
  await expect(wash).toHaveCSS('opacity', '1');
  await expect(wash).toHaveCSS('background-image', /linear-gradient/);
  expect((await wash.evaluate(element => getComputedStyle(element, '::after').backgroundImage)).match(/radial-gradient/g)?.length).toBe(5);
  const [journalBox, washBox] = await Promise.all([journal.boundingBox(), wash.boundingBox()]);
  expect(washBox!.x).toBeLessThan(journalBox!.x);
  expect(washBox!.x + washBox!.width).toBeGreaterThan(journalBox!.x + journalBox!.width);
  await page.screenshot({ path: '/tmp/still-log-top-ink-wash.png' });
});

test('task checkmarks preview completion and reopening on hover', async ({ page }) => {
  await page.unroute('**/api/journal?*');
  await page.route('**/api/journal?*', route => route.fulfill({ json: {
    today, server_time: new Date().toISOString(), active_session: null, next_cursor: null, tags: [], tag: null,
    tasks: [{ id: 9401, content: 'Preview completion', tags: [], parent_id: null, position: 0 }],
    days: [{ date: today, focused_seconds: 0, notes: [], tasks: [{ id: 9402, content: 'Preview reopening', tags: [], parent_id: null, position: 0, completed_at: new Date().toISOString() }] }],
  } }));
  await page.goto('/');
  const unfinished = page.getByRole('button', { name: 'Complete Preview completion', exact: true });
  const finished = page.getByRole('button', { name: 'Reopen Preview reopening', exact: true });
  expect(await unfinished.evaluate(el => getComputedStyle(el, '::after').opacity)).toBe('0');
  await unfinished.hover();
  await expect.poll(() => unfinished.evaluate(el => getComputedStyle(el, '::after').opacity)).toBe('1');
  await expect.poll(() => unfinished.evaluate(el => getComputedStyle(el, '::before').borderColor)).toBe('rgb(24, 113, 186)');
  expect(await unfinished.evaluate(el => getComputedStyle(el, '::before').backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  expect(await unfinished.evaluate(el => getComputedStyle(el, '::after').backgroundColor)).toBe('rgb(24, 113, 186)');
  await unfinished.click();
  await expect(unfinished).toHaveAttribute('data-preview-suppressed', 'true');
  await expect.poll(() => unfinished.evaluate(el => getComputedStyle(el, '::after').opacity)).toBe('0');
  await page.mouse.move(0, 0);
  await unfinished.hover();
  await expect.poll(() => unfinished.evaluate(el => getComputedStyle(el, '::after').opacity)).toBe('1');
  expect(await finished.evaluate(el => getComputedStyle(el, '::after').opacity)).toBe('1');
  await finished.hover();
  await expect.poll(() => finished.evaluate(el => getComputedStyle(el, '::after').opacity)).toBe('0');
});
