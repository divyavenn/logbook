import { expect, test } from './fixtures';

test('a reader without JavaScript can discover and query the complete saved document', async ({ browser, baseURL, request }) => {
  const { today } = await (await request.get('/api/journal?timezone=America/Los_Angeles')).json();
  const parent = await (await request.post('/api/notes', { data: { date: today, content: 'Agent-readable parent', tags: ['agent-reading'] } })).json();
  const child = await (await request.post('/api/notes', { data: { date: today, content: 'Read the [reference](https://example.com/reference)', parent_id: parent.id } })).json();
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
  try {
    const page = await context.newPage();
    const response = await page.goto('/');
    expect(response!.headers().link).toContain('/llms.txt');
    await expect(page.getByRole('link', { name: 'Read the logbook', exact: true })).toHaveAttribute('href', '/journal.md');
    await expect(page.locator('head link[rel="alternate"][type="application/json"]')).toHaveAttribute('href', '/api/agent/journal');
    await expect(page.locator('head link[rel="alternate"][type="text/markdown"]')).toHaveAttribute('href', '/journal.md');
    expect(await (await context.request.get('/llms.txt')).text()).toContain('/api/stats/daily');
    const query = `start=${today}&end=${today}&tag=agent-reading&timezone=America%2FLos_Angeles`;
    const jsonResponse = await context.request.get(`/api/agent/journal?${query}`);
    expect(jsonResponse.headers()['content-type']).toContain('application/json');
    const data = await jsonResponse.json();
    expect(data.days[0].bullets[0].children[0].id).toBe(child.id);
    expect(data.days[0].bullets[0].children[0].links).toEqual([{ text: 'reference', url: 'https://example.com/reference' }]);
    expect(data.days[0].focus.completed_seconds).toBe(0);
    const markdown = await context.request.get(`/journal.md?${query}`);
    expect(markdown.headers()['content-type']).toContain('text/markdown');
    expect(await markdown.text()).toContain('  - Read the [reference](https://example.com/reference)');
    const direct = await context.request.get(`/?${query}`, { headers: { Accept: 'application/json' } });
    expect((await direct.json()).days).toEqual(data.days);
  } finally {
    await context.close();
  }
});

test('agent discovery adds no visible controls to the interactive document', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'New note', exact: true })).toBeFocused();
  await expect(page.getByRole('link', { name: 'Read the logbook', exact: true })).toHaveCount(0);
  await expect(page.locator('head link[rel="service-desc"]')).toHaveAttribute('href', '/openapi.json');
});
