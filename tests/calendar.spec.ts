import { expect, test } from './fixtures';
import AxeBuilder from '@axe-core/playwright';

const today = '2026-09-24';

test('calendar events render in start order and expand indented details with working links', async ({ page }) => {
  await page.route('**/api/journal?*', route => route.fulfill({ json: {
    today, server_time: new Date().toISOString(), active_session: null, next_cursor: null, tags: [], tag: null, tasks: [],
    days: [{ date: today, focused_seconds: 0, longest_session_seconds: 0, session_count: 0, notes: [], tasks: [], entries: [], events: [
      { id: 'all-day', title: 'Company offsite', start: today, end: '2026-09-25', all_day: true, cancelled: false, url: null },
      { id: 'cancelled', title: 'Standup', start: '2026-09-24T08:00:00-07:00', end: '2026-09-24T08:30:00-07:00', all_day: false, cancelled: true, url: null },
      { id: 'planning', title: 'Planning', start: '2026-09-24T09:00:00-07:00', end: '2026-09-24T10:00:00-07:00', all_day: false, cancelled: false,
        url: 'https://zoom.us/j/12345', location: 'Studio 4, North Wing', description: 'Bring the launch brief\nNotes at https://docs.example.com/launch',
        links: ['https://zoom.us/j/12345', 'https://docs.example.com/launch', 'https://files.example.com/agenda.pdf'] },
    ] }],
  } }));
  await page.goto('/');

  const allDay = page.getByText('Company offsite (all day)', { exact: true });
  const cancelled = page.getByText('Standup (8 AM – 8:30 AM)', { exact: true });
  const planning = page.getByRole('button', { name: 'Planning (9 AM – 10 AM)', exact: true });
  await expect(allDay).toBeVisible();
  await expect(allDay).toHaveCSS('font-size', '15px');
  await expect(page.locator('[data-calendar-marker]')).toHaveCount(3);
  const markerStyle = await page.locator('[data-calendar-marker]').first().evaluate(element => {
    const style = getComputedStyle(element, '::before');
    return { width: style.width, height: style.height, borderRadius: style.borderRadius, backgroundColor: style.backgroundColor };
  });
  expect(markerStyle).toMatchObject({ width: '6px', height: '6px', borderRadius: '50%' });
  const linkColor = await planning.evaluate(element => getComputedStyle(element).color);
  const colorTotal = (color: string) => [...color.matchAll(/[+-]?(?:\d+\.?\d*|\.\d+)/g)].slice(0, 3).reduce((total, match) => total + Number(match[0]), 0);
  expect(colorTotal(markerStyle.backgroundColor)).toBeGreaterThan(colorTotal(linkColor));
  const title = planning.locator('[data-calendar-event-title]');
  const time = planning.locator('[data-calendar-event-meta]');
  await expect(title).toHaveCSS('font-weight', '400');
  await expect(time).toHaveCSS('color', linkColor);
  await expect(time).toHaveCSS('font-weight', '300');
  await expect(time).toHaveCSS('font-variant-numeric', 'tabular-nums');
  await expect(time).toHaveCSS('opacity', '1');
  const cancelledMarkerStyle = await page.locator('[data-calendar-marker]').nth(1).evaluate(element => {
    const style = getComputedStyle(element, '::before');
    return { backgroundColor: style.backgroundColor, borderWidth: style.borderTopWidth, borderStyle: style.borderTopStyle };
  });
  expect(cancelledMarkerStyle).toEqual({ backgroundColor: 'rgba(0, 0, 0, 0)', borderWidth: '1px', borderStyle: 'solid' });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'night'; });
  expect(await page.locator('[data-calendar-marker]').first().evaluate(element => getComputedStyle(element, '::before').backgroundColor))
    .toBe(await planning.evaluate(element => getComputedStyle(element).color));
  await page.evaluate(() => { document.documentElement.dataset.theme = 'day'; });
  await expect(cancelled).toHaveCSS('text-decoration-line', 'line-through');
  await expect(planning).toHaveAttribute('aria-expanded', 'false');
  await planning.click();
  await expect(planning).toHaveAttribute('aria-expanded', 'true');
  const details = page.getByRole('group', { name: 'Details for Planning', exact: true });
  await expect(details.getByText('Studio 4, North Wing', { exact: true })).toBeVisible();
  await expect(details.getByText(/Bring the launch brief/)).toBeVisible();
  await expect(details.getByRole('link', { name: 'https://docs.example.com/launch', exact: true })).toHaveAttribute('href', 'https://docs.example.com/launch');
  await expect(details.getByRole('link', { name: 'zoom.us', exact: true })).toHaveAttribute('href', 'https://zoom.us/j/12345');
  await expect(details.getByRole('link', { name: 'files.example.com', exact: true })).toHaveAttribute('href', 'https://files.example.com/agenda.pdf');
  await expect(details.locator('li')).toHaveCount(0);
  await expect(details).toHaveCSS('padding-left', '12px');
  await expect(allDay).not.toHaveAttribute('contenteditable');
  const positions = await Promise.all([allDay.boundingBox(), cancelled.boundingBox(), planning.boundingBox()]);
  expect(positions[0]!.y).toBeLessThan(positions[1]!.y);
  expect(positions[1]!.y).toBeLessThan(positions[2]!.y);
  const date = (await page.getByRole('button', { name: `Focus sessions for ${today}`, exact: true }).boundingBox())!;
  expect(date.y).toBeLessThan(positions[0]!.y);
  await page.waitForTimeout(220);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: '/tmp/still-calendar-events.png' });
  await page.setViewportSize({ width: 440, height: 400 });
  await expect(planning).toBeInViewport();
  await page.screenshot({ path: '/tmp/still-calendar-events-mobile.png' });
});

test('the sidebar calendar modal connects multiple URLs and removes them', async ({ page }) => {
  let nextId = 1;
  let calendars: Array<{ id: number; name: string; host: string; status: 'connecting' | 'connected' | 'error'; error: string | null; created_at: string }> = [];
  await page.route('**/api/calendars**', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET') return route.fulfill({ json: calendars });
    if (request.method() === 'POST') {
      const url = String(request.postDataJSON().url);
      const id = nextId++;
      const calendar = { id, name: id === 1 ? 'Work calendar' : id === 2 ? 'Community events' : `Calendar ${id}`, host: new URL(url).hostname,
        status: 'connected' as const, error: null, created_at: new Date().toISOString() };
      calendars = [...calendars, calendar];
      return route.fulfill({ status: 201, json: calendar });
    }
    const id = Number(path.split('/').at(-1));
    calendars = calendars.filter(calendar => calendar.id !== id);
    return route.fulfill({ status: 204, body: '' });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Tags', exact: true }).hover();
  await page.getByRole('button', { name: 'Manage calendars', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Calendars', exact: true });
  const field = dialog.getByLabel('Calendar URL', { exact: true });
  await field.fill('https://calendar.google.com/private-one/basic.ics');
  await field.press('Enter');
  await expect(dialog.getByText('Work calendar', { exact: true })).toBeVisible();
  await field.fill('https://p123-caldav.icloud.com/private-two.ics');
  await field.press('Enter');

  await expect(dialog.getByText('Community events', { exact: true })).toBeVisible();
  for (let index = 3; index <= 5; index++) {
    await expect(dialog.getByRole('button', { name: /^Remove / }).last()).toBeEnabled();
    await field.fill(`https://calendar-${index}.example/public.ics`);
    await field.press('Enter');
    await expect(dialog.getByText(`Calendar ${index}`, { exact: true })).toBeVisible();
  }
  await expect(field).toBeDisabled();
  await dialog.getByRole('button', { name: 'Remove Work calendar', exact: true }).click();
  await expect(dialog.getByText('Work calendar', { exact: true })).toHaveCount(0);
  await expect(dialog.getByText('Community events', { exact: true })).toBeVisible();
  await expect(field).toBeEnabled();
  await dialog.getByRole('button', { name: 'Calendar URL help', exact: true }).click();
  await expect(dialog.getByText(/Secret address in iCal format/)).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: '/tmp/still-calendar-modal.png' });
});

test('a slow calendar connection can be cancelled without trapping the modal', async ({ page }) => {
  await page.route('**/api/calendars**', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [] });
    await new Promise(resolve => setTimeout(resolve, 1500));
    return route.fulfill({ status: 201, json: { id: 1, name: 'Slow calendar', host: 'calendar.example', status: 'connecting', error: null, created_at: new Date().toISOString() } });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Tags', exact: true }).hover();
  await page.getByRole('button', { name: 'Manage calendars', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Calendars', exact: true });
  const field = dialog.getByLabel('Calendar URL', { exact: true });
  await field.fill('https://calendar.example/public.ics');
  await field.press('Enter');
  await expect(field).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel calendar connection', exact: true }).click();
  await expect(field).toBeEnabled();
});

test('calendar URLs connect in the background while the field remains usable', async ({ page }) => {
  let nextId = 1;
  let calendars: Array<{ id: number; name: string; host: string; status: 'connecting' | 'connected'; error: null; created_at: string }> = [];
  await page.route('**/api/calendars**', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: calendars });
    const url = String(route.request().postDataJSON().url);
    const id = nextId++;
    const calendar = { id, name: new URL(url).hostname, host: new URL(url).hostname, status: 'connecting' as const, error: null, created_at: new Date().toISOString() };
    calendars = [...calendars, calendar];
    setTimeout(() => { calendars = calendars.map(item => item.id === id ? { ...item, name: `Calendar ${id}`, status: 'connected' as const } : item); }, 900);
    return route.fulfill({ status: 201, json: calendar });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Tags', exact: true }).hover();
  await page.getByRole('button', { name: 'Manage calendars', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Calendars', exact: true });
  const field = dialog.getByLabel('Calendar URL', { exact: true });
  await field.fill('https://one.example/public.ics');
  await field.press('Enter');
  await expect(dialog.getByRole('status', { name: 'Connecting one.example', exact: true })).toBeVisible();
  await expect(field).toBeEnabled();
  await field.fill('https://two.example/public.ics');
  await field.press('Enter');
  await expect(dialog.getByRole('status', { name: 'Connecting two.example', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Remove Calendar 1', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Remove Calendar 2', exact: true })).toBeVisible();
});

test('a failed background connection exposes its error when its alert icon is clicked', async ({ page }) => {
  let added = false;
  let calendar = { id: 1, name: 'calendar.example', host: 'calendar.example', status: 'connecting' as 'connecting' | 'error', error: null as string | null, created_at: new Date().toISOString() };
  await page.route('**/api/calendars**', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: added && calendar.id ? [calendar] : [] });
    if (route.request().method() === 'DELETE') { calendar = { ...calendar, id: 0 }; return route.fulfill({ status: 204, body: '' }); }
    added = true;
    setTimeout(() => { calendar = { ...calendar, status: 'error', error: 'Google is temporarily rate-limiting this calendar feed.' }; }, 500);
    return route.fulfill({ status: 201, json: calendar });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Tags', exact: true }).hover();
  await page.getByRole('button', { name: 'Manage calendars', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Calendars', exact: true });
  const field = dialog.getByLabel('Calendar URL', { exact: true });
  await field.fill('https://calendar.example/public.ics');
  await field.press('Enter');
  const alert = dialog.getByRole('button', { name: 'Show error for calendar.example', exact: true });
  await expect(alert).toBeVisible();
  const [nameBox, alertBox] = await Promise.all([dialog.getByText('calendar.example', { exact: true }).boundingBox(), alert.boundingBox()]);
  expect(alertBox!.x - (nameBox!.x + nameBox!.width)).toBeLessThan(12);
  await alert.click();
  const errorMessage = dialog.getByText('Google is temporarily rate-limiting this calendar feed.', { exact: true });
  await expect(errorMessage).toBeVisible();
  await dialog.getByRole('button', { name: 'Calendar URL help', exact: true }).click();
  const helpMessage = dialog.getByText(/On the desktop Google Calendar website/);
  const textStyle = (element: HTMLElement) => {
    const style = getComputedStyle(element);
    return { fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight, opacity: style.opacity };
  };
  expect(await errorMessage.evaluate(textStyle)).toEqual(await helpMessage.evaluate(textStyle));
  await expect(errorMessage).toHaveCSS('color', 'rgb(153, 73, 59)');
  await alert.hover();
  await expect(errorMessage).toBeVisible();
  const [messageBox, removeBox] = await Promise.all([errorMessage.boundingBox(), dialog.getByRole('button', { name: 'Remove calendar.example', exact: true }).boundingBox()]);
  expect(messageBox!.y).toBeGreaterThan(removeBox!.y);
  expect(messageBox!.y - (removeBox!.y + removeBox!.height)).toBeLessThan(4);
  await expect(dialog.getByRole('button', { name: 'Remove calendar.example', exact: true })).toBeVisible();
  await alert.click();
  await expect(errorMessage).toHaveCount(0);
});
