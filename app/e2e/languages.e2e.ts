import { test, expect } from '@playwright/test';

for (const [language, history] of Object.entries({ de: 'Chatverlauf', fr: 'Historique', es: 'Historial', pt: 'Histórico', it: 'Cronologia', zh: '历史记录', ja: '履歴', ko: '대화 기록' })) {
  test(`loads and displays the ${language} interface`, async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 720 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`/?setup=done&view=chat&lang=${language}`);
    await expect(page.locator('html')).toHaveAttribute('lang', language);
    await expect(page.locator('.chatHistory h2')).toHaveText(history);
    await expect(page.locator('.chatComposer textarea')).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}

test('the language picker exposes all ten languages and changes the interface', async ({ page }) => {
  await page.goto('/?setup=done&view=settings&lang=en');
  const language = page.getByRole('combobox', { name: 'Language', exact: true });
  await language.click();
  await expect(page.getByRole('option')).toHaveCount(10);
  await page.getByRole('option', { name: '日本語', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await expect(page.getByRole('combobox', { name: '言語', exact: true })).toContainText('日本語');
});
