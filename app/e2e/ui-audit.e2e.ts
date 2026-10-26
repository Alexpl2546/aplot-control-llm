import { test, expect } from '@playwright/test';

for (const [width, height] of [[1440, 900], [1100, 720]]) {
  for (const theme of ['dark', 'light']) {
    test(`all pages remain usable with a pinned sidebar: ${width}x${height} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      for (const view of ['dashboard', 'chat', 'agentWorkspace', 'configuration', 'models', 'profiles', 'performance', 'logs', 'apiDocs']) {
        await page.goto(`/?setup=done&view=${view}&lang=ru&theme=${theme}`);
        await expect(page.locator('.kShell')).toHaveAttribute('aria-busy', 'false');
        await expect(page.locator('.routeLoading')).toHaveCount(0);
        await expect(page.locator('main')).not.toBeEmpty();
        const sidebar = await page.locator('.kSidebar').boundingBox();
        const main = await page.locator('main').boundingBox();
        expect(main!.x, `${view}: sidebar covers the page`).toBeGreaterThanOrEqual(sidebar!.x + sidebar!.width - 1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), view).toBe(true);
        expect(errors, view).toEqual([]);
      }
    });
  }
}

test('sidebar pin toggles the rail, hover overlay, and saved preference', async ({ page }) => {
  await page.goto('/?setup=done&view=dashboard&lang=en');
  await page.getByRole('button', { name: 'Collapse menu', exact: true }).click();
  const mainBox=(await page.locator('main').boundingBox())!;
  await page.mouse.move(mainBox.x+mainBox.width-30,mainBox.y+30);
  await expect(page.locator('.kSidebar')).toHaveClass(/isRail/);
  await page.reload();
  await expect(page.locator('.kShell')).toHaveClass(/isUnpinned/);
  await page.locator('.kSidebar').hover();
  await expect(page.locator('.kSidebar')).not.toHaveClass(/isRail/);
  await page.getByRole('button', { name: 'Pin menu', exact: true }).click();
  await expect(page.locator('.kShell')).not.toHaveClass(/isUnpinned/);
});

test('clearing technical logs on pause empties the visible log', async ({ page }) => {
  await page.goto('/?setup=done&view=logs&lang=en');
  await expect(page.locator('.kShell')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Technical log', exact: true }).click();
  await page.evaluate(async () => {
    const modulePath = performance.getEntriesByType('resource').map(item => item.name).find(url => /\/src\/store\/control\.ts(?:\?|$)/.test(url)) ?? '/src/store/control.ts';
    const { useControlStore } = await import(/* @vite-ignore */ modulePath);
    const state = useControlStore.getState();
    const run = state.runs.find((item: { info: { runId: string } }) => item.info.runId === state.selectedRunId);
    state.appendRunLog({ runId: run.info.runId, generation: run.info.generation, line: { id: 'ui-audit-log', timestamp: new Date().toISOString(), level: 'INFO', source: 'control', message: 'UI audit log message' } });
  });
  await expect(page.locator('.logRow').first()).toBeVisible();
  await page.getByRole('button', { name: 'Pause autoscroll', exact: true }).click();
  await page.getByRole('button', { name: 'Clear logs', exact: true }).click();
  await expect(page.locator('.logRow')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Resume autoscroll', exact: true })).toBeVisible();
});

test('navigation commits promptly while the visual transition settles', async ({ page }) => {
  await page.goto('/?setup=done&view=dashboard&lang=en');
  await expect(page.locator('.kShell')).toHaveAttribute('aria-busy', 'false');
  await page.evaluate(async () => {
    const path = '/src/lib/viewModules.ts';
    const { viewModules } = await import(/* @vite-ignore */ path);
    await viewModules.configuration();
  });
  const feedback = await page.evaluate(async () => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('.kNav button')].find(node => node.textContent?.includes('Launch Parameters'))!;
    button.click();
    await new Promise(requestAnimationFrame);
    const main = document.querySelector('main')!;
    const style = getComputedStyle(main);
    return { selected: button.getAttribute('aria-current'), loading: !!main.querySelector('.routeLoading'), animation: style.animationName, duration: style.animationDuration, delay: style.animationDelay };
  });
  expect(feedback).toMatchObject({ selected: 'page', animation: 'kRouteEnter', duration: '0.22s', delay: '0s' });
  await expect(page.locator('#configuration-engine-tab')).toBeVisible();
  const button = page.getByRole('navigation').getByRole('button', { name: 'Logs', exact: true });
  await button.hover();
  const box = (await button.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  expect(await button.evaluate(node => getComputedStyle(node).transitionDuration)).toBe('0.045s');
  await page.mouse.up();
});

test('reduced motion keeps navigation and typing immediate without animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?setup=done&view=chat&lang=en');
  await expect(page.locator('.kShell')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('main')).toHaveCSS('animation-name', 'none');
  const input = page.locator('.chatComposer textarea');
  await expect(input).toBeEnabled();
  const draft = 'Instant input — проверка ввода — テキスト';
  await input.fill(draft);
  await expect(input).toHaveValue(draft);
  await expect(page.locator('.chatComposer')).toHaveCSS('transition-delay', '0s');
});
