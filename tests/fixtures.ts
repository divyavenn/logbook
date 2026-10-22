import { test as base, expect } from '@playwright/test';

export const test = base.extend<{ cleanDatabase: void }>({
  cleanDatabase: [async ({ request }, use) => {
    const response = await request.delete('/api/test/reset');
    expect(response.status()).toBe(204);
    await use();
  }, { auto: true }],
});

export { expect, type Locator, type Page } from '@playwright/test';

// The task list has a pane of its own only when there is no room above the
// log. Reaching it means selecting that pane where it exists, and nothing
// where the log already carries the list.
export async function openTasks(page: import('@playwright/test').Page): Promise<void> {
  const { expect: check } = await import('@playwright/test');
  // The shape is decided once the list has been measured, so wait for the page
  // to have its entries before asking which pane the tasks are in.
  await check(page.getByRole('textbox', { name: 'New note', exact: true })).toBeVisible();
  const tab = page.getByRole('tab', { name: 'tasks', exact: true });
  if (await tab.count()) await tab.click();
  await check(page.getByRole('region', { name: 'to do', exact: true })).toBeVisible();
}
