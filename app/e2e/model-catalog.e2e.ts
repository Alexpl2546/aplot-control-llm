import { test, expect } from '@playwright/test';

test('three saved profiles stay three when their native configurations are discovered', async ({ page }) => {
  await page.goto('/?setup=done&view=profiles&lang=ru');
  await expect(page.locator('.profilesGrid .profileCard')).toHaveCount(3);
  await page.evaluate(async () => {
    const { useControlStore } = await import('/src/store/control.ts');
    const state = useControlStore.getState();
    useControlStore.setState({
      profiles: state.profiles.map((profile: { config: object }, index: number) => ({ ...profile, config: { ...profile.config, engine: 'strata', ctxSize: [131072, 204800, 512000][index] } })),
      strataModels: state.profiles.map((_: unknown, index: number) => ({ configPath: `C:/strata/config-${index}.json`, modelName: `Native duplicate ${index}`, contextLength: [131072, 204800, 512000][index] })),
    });
  });
  await page.getByRole('button', { name: 'Strata', exact: true }).click();
  await expect(page.locator('.profilesGrid .profileCard')).toHaveCount(3);
  await expect(page.getByRole('tab', { name: /Профили/ })).toContainText('3');
  await expect(page.getByText('Native duplicate 0', { exact: true })).toHaveCount(0);
  await expect(page.locator('.profilesGrid')).not.toContainText('q8_0');
  await page.screenshot({ path: 'artifacts/model-catalog-2026-10-24/profiles.png', fullPage: true });
});

for (const [width, height] of [[1920, 1080], [1100, 720]]) {
  test(`model catalog layout and engine folders ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/?setup=done&view=models&lang=ru&theme=dark');
    await page.getByRole('button', { name: 'Скачать модель', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Скачать модель', exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'llama.cpp', exact: true }).click();
    const folder = dialog.getByRole('textbox', { name: 'Папка назначения' });
    await expect(folder).toHaveValue('C:/Aplot/models/llama');
    await expect(dialog.locator('.modelHubCard')).toHaveCount(3);
    await expect(dialog.getByRole('combobox', { name: 'Сортировка моделей', exact: true })).toBeVisible();
    await expect(dialog.locator('.modelCatalogSpecs').first()).toContainText('Параметры');
    await page.screenshot({ path: `artifacts/model-catalog-2026-10-24/llama-${width}.png`, fullPage: true });
    await dialog.getByRole('button', { name: 'Strata', exact: true }).click();
    await expect(folder).toHaveValue('C:/Aplot/models/strata');
    await expect(dialog.locator('.modelCatalogCard')).toHaveCount(21);
    await expect(dialog.locator('.modelCatalogCard').first()).toContainText('Загрузка комплекта');
    await expect(dialog.locator('.modelCatalogCard').first()).not.toContainText('fits');
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: `artifacts/model-catalog-2026-10-24/strata-${width}.png`, fullPage: true });
    expect(errors).toEqual([]);
  });
}
