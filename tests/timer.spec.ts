import { expect, test } from './fixtures';

test('timer responds before the network and touch controls request haptic feedback', async ({ page }) => {
  await page.addInitScript(() => {
    (window as typeof window & { hapticPatterns: VibratePattern[] }).hapticPatterns = [];
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: (pattern: VibratePattern) => {
      (window as typeof window & { hapticPatterns: VibratePattern[] }).hapticPatterns.push(pattern);
      return true;
    } });
  });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/timer/start?*', async route => {
    await gate;
    await route.fulfill({ json: { id: 700, started_at: new Date().toISOString(), ended_at: null, duration_seconds: 0 } });
  });
  await page.goto('/');
  const start = page.getByRole('button', { name: 'Start focus timer', exact: true });
  await start.evaluate(element => element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch', pointerId: 1, isPrimary: true })));
  expect(await page.evaluate(() => (window as typeof window & { hapticPatterns: VibratePattern[] }).hapticPatterns)).toEqual([14]);
  await start.click();
  const stop = page.getByRole('button', { name: 'Stop focus timer', exact: true });
  await expect(stop).toHaveAttribute('aria-pressed', 'true');
  await expect(stop).toHaveAttribute('aria-disabled', 'true');
  await expect(stop).toHaveCSS('opacity', '1');
  await expect(page.getByTestId('page')).toHaveCSS('transition-duration', '0s');
  await expect(page.getByTestId('page')).toHaveAttribute('data-focus-running', 'true');
  const response = page.waitForResponse(value => value.url().includes('/api/timer/start') && value.ok());
  release();
  await response;
  await expect(page.getByRole('button', { name: /focus timer/ })).not.toHaveAttribute('aria-disabled', 'true');
});

test('timer shows ticking seconds, running colors in both themes, and resets on stop', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-16T10:02:03-07:00') });
  await page.clock.pauseAt(new Date('2026-09-16T10:02:03-07:00'));
  let running = true;
  const session = { id: 500, started_at: '2026-09-16T09:00:00-07:00', ended_at: null, duration_seconds: 3723 };
  await page.route('**/api/journal?*', async route => route.fulfill({ json: {
    today: '2026-09-16', server_time: await page.evaluate(() => new Date().toISOString()),
    active_session: running ? session : null, next_cursor: null, tasks: [], tags: [],
    days: [{ date: '2026-09-16', focused_seconds: 3723, session_count: 1, longest_session_seconds: 3723,
      notes: [{ id: 501, content: 'Keep this readable', tags: [], parent_id: null, position: 0 }] }],
  } }));
  await page.route('**/api/timer/stop?*', route => { running = false; return route.fulfill({ json: session }); });
  await page.route('**/api/timer/start?*', route => { running = true; return route.fulfill({ json: session }); });
  await page.goto('/');
  const timer = page.getByRole('button', { name: 'Stop focus timer', exact: true });
  const readout = page.getByTestId('compact-timer-time');
  await expect(readout).toHaveText('01:02:03');
  await expect(timer).toHaveAttribute('aria-pressed', 'true');
  await expect(timer.locator('svg')).toBeVisible();
  await page.clock.runFor(200);
  await expect(timer).toHaveCSS('width', '44px');
  await expect(timer).toHaveCSS('height', '44px');
  await expect.poll(async () => (await timer.boundingBox())!.width).toBeGreaterThan(44);
  await expect(page.getByTestId('page')).toHaveAttribute('data-focus-running', 'true');
  await expect(page.getByRole('button', { name: 'Focus sessions for 2026-09-16', exact: true })).toHaveCSS('opacity', '0.6');
  await expect(page.getByRole('group', { name: 'Keep this readable', exact: true })).toHaveCSS('opacity', '1');
  await expect(timer).toHaveCSS('opacity', '1');
  await expect(page.getByRole('main')).toHaveCSS('filter', 'none');
  await expect(page.getByRole('group', { name: 'Keep this readable', exact: true })).toHaveCSS('color', 'color(srgb 0.118588 0.118588 0.112)');
  const activeLightBackground = await page.getByTestId('page').evaluate(el => getComputedStyle(el).backgroundColor);
  await expect(timer).toHaveCSS('background-color', 'rgb(24, 113, 186)');
  await page.clock.runFor(200);
  expect(Number((await timer.evaluate(el => getComputedStyle(el, '::before').borderColor)).match(/\d+/)?.[0])).toBeLessThan(120);
  await page.clock.runFor(1000);
  await expect(readout).toHaveText('01:02:04');
  await page.mouse.move(1000, 500);
  await page.getByRole('navigation', { name: 'Tags' }).hover();
  await page.getByRole('switch', { name: 'Night mode', exact: true }).click();
  await page.clock.runFor(200);
  await expect(page.getByRole('main')).toHaveCSS('filter', 'none');
  await expect(timer).toHaveCSS('background-color', 'rgb(51, 94, 98)');
  const activeDarkBackground = await page.getByTestId('page').evaluate(element => getComputedStyle(element).backgroundColor);
  const activeDarkEdge = await page.getByTestId('log-top-ink-wash').evaluate(element => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--edge-paper)';
    element.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  expect(activeDarkEdge).toBe(activeDarkBackground);
  await timer.click();
  await page.mouse.move(1000, 500);
  await page.clock.runFor(200);
  const stopped = page.getByRole('button', { name: 'Start focus timer', exact: true });
  await expect.poll(() => stopped.evaluate(el => getComputedStyle(el, '::after').animationName)).toBe('none');
  await expect(stopped).toHaveCSS('scale', 'none');
  await expect(readout).toHaveText('00:00:00');
  await expect(stopped).toHaveAttribute('aria-pressed', 'false');
  await expect(stopped).toHaveCSS('background-color', 'rgb(36, 57, 74)');
  await page.mouse.move(1000, 500);
  await page.getByRole('navigation', { name: 'Tags' }).hover();
  await page.getByRole('switch', { name: 'Night mode', exact: true }).click();
  await page.mouse.move(1000, 500);
  await page.clock.runFor(200);
  await page.waitForTimeout(250);
  await expect(page.getByRole('main')).toHaveCSS('filter', 'none');
  const idleLightBackground = await page.getByTestId('page').evaluate(el => getComputedStyle(el).backgroundColor);
  const redChannel = (color: string) => {
    const values = color.match(/[\d.]+/g)?.map(Number) ?? [];
    return color.startsWith('color(') ? values[0] * 255 : values[0];
  };
  expect(redChannel(idleLightBackground) - redChannel(activeLightBackground)).toBeGreaterThan(25);
  await expect(stopped).toHaveCSS('background-color', 'rgb(86, 98, 107)');
  await stopped.click();
  const restarted = page.getByRole('button', { name: 'Stop focus timer', exact: true });
  await page.clock.runFor(16);
  await expect(restarted).toHaveCSS('scale', '1.03');
  await expect.poll(() => restarted.evaluate(el => getComputedStyle(el, '::after').animationName)).not.toBe('none');
  await page.setViewportSize({ width: 260, height: 180 });
  await expect(restarted).toBeVisible();
  await expect(restarted).toHaveCSS('width', '44px');
  await expect(restarted).toHaveCSS('height', '44px');
  await expect(restarted).toHaveCSS('scale', '1.03');
  await expect(restarted).toHaveCSS('background-color', 'rgb(24, 113, 186)');
  await expect(restarted.locator('svg')).toBeVisible();
  await expect(readout).toHaveText('01:02:04');
  expect(await restarted.evaluate(element => ({
    staticRing: getComputedStyle(element, '::before').top,
    pulse: getComputedStyle(element, '::after').animationName,
  }))).toEqual({ staticRing: '-3px', pulse: expect.not.stringMatching(/^none$/) });
});
