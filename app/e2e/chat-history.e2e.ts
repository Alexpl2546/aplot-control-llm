import { test, expect } from '@playwright/test';

test('chat history preserves replies and drafts, supports search, rename, continuation and deletion', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.goto('/?setup=done&view=chat&lang=en');
  const input = page.locator('.chatComposer textarea');
  await expect(input).toBeEnabled();
  await input.fill('First saved conversation');
  await page.locator('.chatComposer button[type=submit]').click();
  await expect(page.locator('.chatMessage.is-assistant')).toContainText('demonstration response');
  await expect(page.locator('.chatComposer button[type=submit]')).toBeVisible();
  await input.fill('Unsent follow-up');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(page.locator('.chatHistoryItem')).toHaveCount(2);
  await page.locator('.chatHistorySelect').filter({ hasText: 'First saved conversation' }).click();
  await expect(input).toHaveValue('Unsent follow-up');
  await page.getByRole('button', { name: 'Rename: First saved conversation', exact: true }).click();
  await page.getByRole('textbox', { name: 'Conversation title', exact: true }).fill('Renamed conversation');
  await page.locator('.chatHistoryRename button[type=submit]').click();
  await page.getByRole('searchbox', { name: 'Search conversations', exact: true }).fill('no matching conversation');
  await expect(page.locator('.chatHistoryItem')).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Search conversations', exact: true }).fill('renamed');
  await expect(page.locator('.chatHistoryItem')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('aplot.chat-history.v1') ?? '{}');
    return saved.conversations?.some((item: { title: string; thread: { draft: string } }) => item.title === 'Renamed conversation' && item.thread.draft === 'Unsent follow-up');
  })).toBe(true);
  await page.reload();
  await expect(page.locator('.chatHistorySelect').filter({ hasText: 'Renamed conversation' })).toBeVisible();
  await expect(input).toHaveValue('Unsent follow-up');
  await expect(page.locator('.chatMessage.is-user')).toContainText('First saved conversation');
  // The demo run gets a new start identity on reload, just like a restarted server.
  await expect(page.locator('.chatTargetUnavailable')).toBeVisible();
  await page.getByRole('button', { name: 'Continue with saved context', exact: true }).click();
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue('Unsent follow-up');
  await expect(page.locator('.chatMessage.is-assistant')).toContainText('demonstration response');
  await expect(page.locator('.chatHistoryItem')).toHaveCount(3);
  await page.locator('.chatHistoryItem.is-selected').getByRole('button', { name: 'Delete: Renamed conversation', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('.chatHistoryItem')).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('streaming keeps the reader position and the composer leaves the latest answer visible', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.goto('/?setup=done&view=chat&lang=en');
  const input = page.locator('.chatComposer textarea'), transcript = page.locator('.chatMessages');
  await input.fill('A long question for scroll verification. '.repeat(120));
  await page.locator('.chatComposer button[type=submit]').click();
  await expect(page.locator('.chatMessage.is-assistant')).toContainText('demonstration');
  await transcript.evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
  await expect(page.locator('.chatComposer button[type=submit]')).toBeVisible();
  expect(await transcript.evaluate(node => node.scrollTop)).toBe(0);
  await transcript.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await expect(page.locator('.chatMessage.is-assistant p').last()).toBeInViewport();
  const reply = await page.locator('.chatMessage.is-assistant p').last().boundingBox();
  const composer = await page.locator('.chatComposer').boundingBox();
  expect(reply!.y + reply!.height).toBeLessThanOrEqual(composer!.y);
});
