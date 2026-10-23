import { expect, test } from './fixtures';
import AxeBuilder from '@axe-core/playwright';

const today = '2026-09-17';
test.beforeEach(async ({ page }) => {
  await page.route('**/api/journal?*', route => route.fulfill({ json: {
    today, server_time: new Date().toISOString(), active_session: null, next_cursor: null, tags: [], tag: null,
    tasks: [{ id: 9001, content: 'First task', tags: [], parent_id: null, position: 0 }],
    days: [
      { date: today, focused_seconds: 0, notes: Array.from({ length: 30 }, (_, i) => ({ id: 9100 + i, content: `Current note ${i}`, tags: [], parent_id: null, position: i })) },
      { date: '2026-09-16', focused_seconds: 0, notes: [{ id: 9200, content: 'Older note', tags: [], parent_id: null, position: 0 }] },
    ],
  } }));
});

test('a long task list takes a tab of its own, and the sidebar keeps its side', async ({ page }) => {
  await page.route('**/api/journal?*', route => route.fulfill({ json: {
    today, server_time: new Date().toISOString(), active_session: null, next_cursor: null, tags: [], tag: null,
    tasks: Array.from({ length: 40 }, (_, i) => ({ id: 9300 + i, content: `Stacked task ${i}`, tags: [], parent_id: null, position: i })),
    days: [{ date: today, focused_seconds: 0, notes: [{ id: 9400, content: 'A note below', tags: [], parent_id: null, position: 0 }] }],
  } }));
  await page.goto('/');
  // Asking for more than a fifth of the height is asking for a pane of its own.
  const tabs = page.getByRole('tablist', { name: 'Mobile views' });
  await expect(tabs.getByRole('tab')).toHaveText(['tasks', 'log']);
  // There is still room across, so the tags stay in the sidebar.
  await expect(page.getByRole('navigation', { name: 'Tags' })).toHaveCount(1);
  await page.getByRole('tab', { name: 'tasks', exact: true }).click();
  const section = page.getByRole('region', { name: 'to do', exact: true });
  await expect(section).toBeVisible();
  const viewport = page.getByTestId('task-scroll');
  // The list scrolls inside its own pane.
  expect(await viewport.evaluate(element => element.scrollHeight > element.clientHeight + 8)).toBe(true);
  const wash = page.getByTestId('task-top-ink-wash');
  await expect(wash).toBeAttached();
  await expect(page.getByTestId('task-bottom-ink-wash')).toBeAttached();
  // The first task starts below the wash rather than under it.
  const washBounds = (await wash.boundingBox())!;
  const firstTask = (await page.getByRole('group', { name: 'Stacked task 0', exact: true }).boundingBox())!;
  expect(firstTask.y).toBeGreaterThanOrEqual(washBounds.y + washBounds.height);
  // The scrollbar starts below the wash and is never painted over by it.
  const paneBounds = (await viewport.boundingBox())!;
  expect(paneBounds.y).toBeGreaterThan(washBounds.y);
  expect(washBounds.x + washBounds.width).toBeLessThan(paneBounds.x + paneBounds.width);
  // The log is a tab away, whole.
  await page.getByRole('tab', { name: 'log', exact: true }).click();
  await expect(page.getByRole('group', { name: 'A note below', exact: true })).toBeVisible();
});

test('global timer stays fixed at the top right while tasks stack above the log', async ({ page }) => {
  await page.goto('/');
  const timer = page.getByRole('button', { name: 'Start focus timer', exact: true });
  const readout = page.getByTestId('compact-timer-time');
  const task = page.getByRole('group', { name: 'First task', exact: true });
  const note = page.getByRole('group', { name: 'Current note 0', exact: true });
  for (const width of [1440, 1280, 1024, 900, 760, 641]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByTestId('log-scroll').evaluate(element => { element.scrollTop = 0; });
    // Below the width the sidebar needs, the tags take a tab; the tasks still
    // stack above the log, since the height is not what is short.
    await expect(page.getByRole('tablist', { name: 'Mobile views' })).toHaveCount(width <= 800 ? 1 : 0);
    await expect(page.getByRole('tab', { name: 'tasks', exact: true })).toHaveCount(0);
    const [button, time, first, text] = await Promise.all([
      timer.boundingBox(), readout.boundingBox(), task.boundingBox(), note.boundingBox(),
    ]);
    expect(button!.width).toBe(44);
    expect(button!.height).toBe(44);
    expect(button!.x + button!.width).toBe(width - (width <= 800 ? 12 : 24));
    expect(button!.y).toBe(width <= 800 ? 12 : 20);
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

test('expanding a parent at the foot of the task pane lifts it to show its children', async ({ page }) => {
  await page.unroute('**/api/journal?*');
  const parent = { id: 9500, content: 'Parent at the foot', tags: [], parent_id: null, position: 40, child_count: 3, completed_child_count: 0 };
  await page.route('**/api/journal?*', route => route.fulfill({ json: {
    today, server_time: new Date().toISOString(), active_session: null, next_cursor: null, tags: [], tag: null,
    tasks: [
      // Enough to overflow a pane of its own, which is what a list this long gets.
      ...Array.from({ length: 40 }, (_, i) => ({ id: 9510 + i, content: `Filler task ${i}`, tags: [], parent_id: null, position: i })),
      parent,
      ...Array.from({ length: 3 }, (_, i) => ({ id: 9520 + i, content: `Hidden child ${i}`, tags: [], parent_id: parent.id, position: i })),
    ],
    days: [{ date: today, focused_seconds: 0, notes: [{ id: 9530, content: 'A note below', tags: [], parent_id: null, position: 0 }] }],
  } }));
  await page.goto('/');
  await page.getByRole('tab', { name: 'tasks', exact: true }).click();
  const viewport = page.getByTestId('task-scroll');
  const row = page.getByRole('group', { name: 'Parent at the foot', exact: true });
  await row.scrollIntoViewIfNeeded();
  const before = (await row.boundingBox())!;
  await page.evaluate(() => {
    const pane = document.querySelector('[data-testid="task-scroll"]')!;
    // Seeded with where the pane already stands, so the steps are its travel.
    const samples: number[] = [pane.scrollTop];
    (window as unknown as { samples: number[] }).samples = samples;
    pane.addEventListener('scroll', () => samples.push(pane.scrollTop));
  });
  await page.getByRole('button', { name: 'Expand Parent at the foot', exact: true }).hover();
  // The pane scrolls so the parent rises and its children come into view.
  await expect.poll(async () => (await row.boundingBox())!.y, { timeout: 4000 }).toBeLessThan(before.y - 8);
  // It travels with the branch rather than jumping once the branch has grown.
  const samples = await page.evaluate(() => (window as unknown as { samples: number[] }).samples);
  expect(samples.length).toBeGreaterThan(3);
  expect(samples).toEqual([...samples].sort((a, b) => a - b));
  const steps = samples.slice(1).map((value, index) => value - samples[index]);
  const travelled = samples[samples.length - 1] - samples[0];
  expect(Math.max(...steps)).toBeLessThan(travelled / 2);
  const pane = (await viewport.boundingBox())!;
  const child = (await page.getByRole('group', { name: 'Hidden child 0', exact: true }).boundingBox())!;
  expect(child.y).toBeGreaterThanOrEqual(pane.y);
  expect(child.y + child.height).toBeLessThanOrEqual(pane.y + pane.height + 1);
  // It never rises above the pane itself.
  expect((await row.boundingBox())!.y).toBeGreaterThanOrEqual(pane.y - 1);
});

test('a short task list sits close to the log below it', async ({ page }) => {
  await page.goto('/');
  const task = (await page.getByRole('group', { name: 'First task', exact: true }).boundingBox())!;
  const section = (await page.getByRole('region', { name: 'to do', exact: true }).boundingBox())!;
  // Only the composer row and a thin creation strip follow the last task.
  expect(section.y + section.height - (task.y + task.height)).toBeLessThanOrEqual(56);
});

test('stacked tasks keep a generous creation area and wrap within the document', async ({ page }) => {
  await page.unroute('**/api/journal?*');
  let tasks: Array<{ id: number; content: string; tags: string[]; parent_id: null; position: number }> = [];
  await page.route('**/api/journal?*', route => route.fulfill({ json: {
    today, server_time: new Date().toISOString(), active_session: null, next_cursor: null, tags: [], tag: null, tasks,
    days: [{ date: today, focused_seconds: 0, notes: [{ id: 9300, content: 'Width reference', tags: [], parent_id: null, position: 0 }] }],
  } }));
  await page.goto('/');
  const emptyArea = page.getByRole('button', { name: 'Add task', exact: true });
  await expect(emptyArea).toBeVisible();
  expect((await emptyArea.boundingBox())!.height).toBeGreaterThan(80);
  await expect(page.getByRole('textbox', { name: 'New task', exact: true })).toHaveCount(0);
  await emptyArea.click({ position: { x: 20, y: (await emptyArea.boundingBox())!.height - 10 } });
  await expect(page.getByRole('textbox', { name: 'New task', exact: true })).toBeFocused();

  tasks = [{ id: 9301, content: 'A deliberately very long task entry that keeps going until it has to wrap before reaching the timer at the established outer edge of the document', tags: [], parent_id: null, position: 0 }];
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

test('what has no room gets a tab of its own, and the timer stays visible', async ({ page }) => {
  await page.goto('/');
  const timer = page.getByRole('button', { name: 'Start focus timer', exact: true });
  const timerReadout = page.getByTestId('compact-timer-time');
  // No room across puts the sidebar in a tab; none down puts the log in one.
  for (const size of [
    { width: 640, height: 800, panes: ['log', 'tags'] }, { width: 440, height: 700, panes: ['log', 'tags'] },
    { width: 260, height: 700, panes: ['log', 'tags'] }, { width: 440, height: 400, panes: ['tasks', 'log', 'tags'] },
    { width: 260, height: 180, panes: ['tasks', 'log', 'tags'] }, { width: 1000, height: 400, panes: ['tasks', 'log'] },
  ]) {
    await page.setViewportSize(size);
    // The rail answers a hover, so the pointer is parked clear of it first.
    await page.mouse.move(size.width / 2, size.height - 8);
    const tabs = page.getByRole('tablist', { name: 'Mobile views' });
    await expect(tabs).toBeVisible();
    await expect(tabs.getByRole('tab')).toHaveText(size.panes);
    await expect(page.getByRole('tab', { name: 'log', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(timer).toBeInViewport();
    await expect(timerReadout).toHaveText('00:00:00');
    const [activeDot, timerBox] = await Promise.all([
      page.getByRole('tab', { name: 'log', exact: true }).boundingBox(), timer.boundingBox(),
    ]);
    expect(activeDot!.y + activeDot!.height / 2).toBeCloseTo(timerBox!.y + timerBox!.height / 2, 0);
    // Centred while the sidebar keeps its side; where the tags have taken a
    // tab there is no sidebar, and the dots take its place at the left.
    const dots = (await tabs.boundingBox())!;
    if (size.panes.includes('tags')) expect(dots.x).toBeLessThan(size.width / 4);
    else expect(dots.x + dots.width / 2).toBeCloseTo(size.width / 2, 0);
    const rails = page.getByRole('navigation', { name: 'Tags' });
    if (await rails.count()) {
      const rail = (await rails.boundingBox())!;
      expect(dots.x).toBeGreaterThan(rail.x + rail.width);
    }
    expect(dots.x + dots.width).toBeLessThan(timerBox!.x);
    await expect(page.getByRole('tab', { name: 'log', exact: true })).toHaveCSS('font-size', '0px');
    expect(await tabs.getByRole('tab').evaluateAll(elements => elements.map(element => getComputedStyle(element, '::before').width))).toEqual(size.panes.map(() => '6px'));
    // One spacing whatever the number of panes: 12px between dot centres.
    const centres = (await tabs.getByRole('tab').evaluateAll(elements =>
      elements.map(element => element.getBoundingClientRect().x + element.getBoundingClientRect().width / 2)));
    expect(centres.slice(1).map((centre, index) => Math.round(centre - centres[index])))
      .toEqual(size.panes.slice(1).map(() => 12));
    // The rail and the tags tab are the same thing; never both at once.
    await expect(page.getByRole('navigation', { name: 'Tags' })).toHaveCount(size.panes.includes('tags') ? 0 : 1);
    // Where a rail exists its controls stay tucked away until it is hovered.
    // Where the tags have a tab instead, the controls live in that pane.
    if (!size.panes.includes('tags')) {
      await expect(page.getByRole('navigation', { name: 'Tags' }).getByRole('group', { name: 'Page controls' })).toBeHidden();
    }
    const pager = page.getByTestId('mobile-pager');
    await expect(pager).toHaveCSS('scrollbar-width', 'none');
    await expect(pager).toHaveCSS('scroll-snap-type', 'x mandatory');
    await expect(pager).toHaveCSS('overscroll-behavior-x', 'none');
    await expect(pager.locator(':scope > section').first()).toHaveCSS('scroll-snap-stop', 'always');
    await expect(page.getByTestId('log-scroll')).toHaveCSS('scrollbar-width', 'none');
    const [topWash, bottomWash, logBox] = await Promise.all([
      page.getByTestId('log-top-ink-wash').boundingBox(), page.getByTestId('log-bottom-ink-wash').boundingBox(), page.getByTestId('log-scroll').boundingBox(),
    ]);
    expect(topWash!.y).toBeLessThanOrEqual(logBox!.y);
    expect(bottomWash!.y + bottomWash!.height).toBeGreaterThanOrEqual(logBox!.y + logBox!.height);
    const paneGeometry = await pager.evaluate(element => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      panes: [...element.children].map(child => ({ clientWidth: (child as HTMLElement).clientWidth, scrollWidth: (child as HTMLElement).scrollWidth })),
    }));
    expect(paneGeometry.scrollWidth).toBe(paneGeometry.clientWidth * size.panes.length);
    expect(paneGeometry.panes.every(pane => pane.clientWidth === paneGeometry.clientWidth && pane.scrollWidth <= pane.clientWidth), JSON.stringify(paneGeometry)).toBe(true);
    if (size.width <= 640) {
      const main = (await page.getByRole('main').boundingBox())!;
      expect(main.x).toBe(48);
      expect(size.width - main.x - main.width).toBe(16);
    }
    // Where there is room beside the log, the sidebar keeps it and has no tab.
    if (size.panes.includes('tags')) {
      await page.getByRole('tab', { name: 'tags', exact: true }).click();
      await expect(page.getByRole('tab', { name: 'tags', exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('group', { name: 'Page controls' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'all', exact: true })).toBeVisible();
    }
    // Where the log keeps the task list above it, there is no tasks tab.
    await page.getByRole('tab', { name: size.panes.includes('tasks') ? 'tasks' : 'log', exact: true }).click();
    await expect(page.getByRole('tab', { name: size.panes.includes('tasks') ? 'tasks' : 'log', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('group', { name: 'First task', exact: true })).toBeInViewport();
    expect((await page.getByRole('group', { name: 'First task', exact: true }).boundingBox())!.height).toBeLessThanOrEqual(40);
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
    const mobileMain = (await mobile.getByRole('main').boundingBox())!;
    expect(mobileMain.x).toBe(24);
    expect(440 - mobileMain.x - mobileMain.width).toBe(16);
    await expect(mobile.getByRole('navigation', { name: 'Tags' })).toHaveCount(0);
    const composer = mobile.getByRole('textbox', { name: 'New note', exact: true });
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
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await page.goto('/');
  const tabs = page.getByRole('tablist', { name: 'Mobile views' });
  const pager = page.getByTestId('mobile-pager');
  await expect(tabs.getByRole('tab', { name: 'log', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('log-scroll').evaluate(element => { element.scrollTop = 0; });
  const strip = (await page.locator('[data-page-turn]').boundingBox())!;
  const swipe = async (from: number, to: number) => {
    // The strip above the panes turns the page; a touch on the entries scrolls
    // them instead, so neither gesture is ambiguous.
    const y = strip.y + strip.height / 2;
    const point = (x: number) => ({ x, y, id: 0, radiusX: 1, radiusY: 1, force: 1 });
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(from)] });
    for (let step = 1; step <= 5; step++) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(from + (to - from) * step / 5)] });
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  // A tall narrow window keeps the task list with the log, so the panes are
  // the log and the tags, in that order.
  // Clear of the dots at one end and the timer at the other.
  await swipe(strip.x + strip.width * .6, strip.x + strip.width * .15);
  await expect(tabs.getByRole('tab', { name: 'tags', exact: true })).toHaveAttribute('aria-selected', 'true');
  // The turn is animated, so it is the settled position that matters.
  await expect.poll(() => pager.evaluate(element => element.scrollLeft / element.clientWidth)).toBeCloseTo(1, 1);
  await swipe(strip.x + strip.width * .15, strip.x + strip.width * .6);
  await expect(tabs.getByRole('tab', { name: 'log', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => pager.evaluate(element => element.scrollLeft / element.clientWidth)).toBeCloseTo(0, 1);
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
  // It stops short of the scrollbar column, so the bar's ends stay crisp.
  const right = journalBox!.x + journalBox!.width;
  expect(washBox!.x + washBox!.width).toBeLessThanOrEqual(right - 8);
  // The gap is only the bar's own column: content still fades under the wash.
  expect(washBox!.x + washBox!.width).toBeGreaterThanOrEqual(right - 16);
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
