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

test('technical log scrolls with the wheel and follows newly appended entries', async ({ page }) => {
  await page.goto('/?setup=done&view=logs&lang=en');
  await expect(page.locator('.kShell')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Technical log', exact: true }).click();

  await page.evaluate(async () => {
    const modulePath = performance.getEntriesByType('resource').map(item => item.name).find(url => /\/src\/store\/control\.ts(?:\?|$)/.test(url)) ?? '/src/store/control.ts';
    const { useControlStore } = await import(/* @vite-ignore */ modulePath);
    const logs = Array.from({ length: 100 }, (_, index) => ({
      id: `ui-scroll-log-${index}`,
      timestamp: new Date(1_700_000_000_000 + index * 1000).toISOString(),
      level: 'INFO' as const,
      source: 'fixture',
      message: `Fixture log entry ${index + 1}`,
    }));
    useControlStore.setState({ logs });
  });

  const rows = page.locator('.logRows');
  await expect.poll(() => rows.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  await expect.poll(() => rows.evaluate(node => node.scrollTop + node.clientHeight >= node.scrollHeight - 2)).toBe(true);

  const beforeWheel = await rows.evaluate(node => node.scrollTop);
  const box = (await rows.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -400);
  await expect.poll(() => rows.evaluate(node => node.scrollTop)).toBeLessThan(beforeWheel);

  await page.evaluate(async () => {
    const modulePath = performance.getEntriesByType('resource').map(item => item.name).find(url => /\/src\/store\/control\.ts(?:\?|$)/.test(url)) ?? '/src/store/control.ts';
    const { useControlStore } = await import(/* @vite-ignore */ modulePath);
    useControlStore.setState(state => ({ logs: [...state.logs, {
      id: 'ui-scroll-log-latest',
      timestamp: new Date().toISOString(),
      level: 'INFO',
      source: 'fixture',
      message: 'Latest fixture log entry',
    }] }));
  });
  await expect(rows.getByText('Latest fixture log entry', { exact: true })).toBeAttached();
  await expect.poll(() => rows.evaluate(node => node.scrollTop + node.clientHeight < node.scrollHeight - 2)).toBe(true);
  await page.getByRole('button', { name: 'Go to latest entries' }).click();
  await expect.poll(() => rows.evaluate(node => node.scrollTop + node.clientHeight >= node.scrollHeight - 2)).toBe(true);
});

test('agent workspace keeps tools and context within reach of the conversation', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.addInitScript(() => {
    const task = { id: 'task', projectId: 'project', title: 'A task with a longer name for the navigator', createdAt: 1, updatedAt: 1, archived: false, unread: false };
    localStorage.setItem('aplot-agent-workspace-v2-preview', JSON.stringify({
      version: 2, revision: 0, data: {
        projects: [{ id: 'project', name: 'Design', path: 'C:/example/design', skills: '', createdAt: 1 }],
        tasks: [task, { ...task, id: 'archive', title: 'Archived task', archived: true }],
        selectedProjectId: 'project', selectedTaskId: 'task', memory: [], presets: [],
        threads: { task: { context: { context_used: 5000, context_max: 10000, context_source: 'provider_usage_plus_estimate',
          context_estimated: true, estimated_total: 2000, categories: [{ id: 'rules', label: 'Rules', tokens: 2000 }], context_files: [], updatedAt: 1 } } },
      },
    }));
  });
  await page.goto('/?setup=done&view=agentWorkspace&lang=en');
  const collections = page.locator('.awTaskCollections');
  await page.getByRole('button', { name: 'Projects and tasks', exact: true }).click();
  await expect(collections.getByRole('button', { name: 'Active tasks', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await collections.getByRole('button', { name: 'Archived tasks', exact: true }).click();
  await expect(page.locator('.awTaskList')).toContainText('Archived task');
  await collections.getByRole('button', { name: 'Active tasks', exact: true }).click();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Task tools', exact: true }).click();
  const tools = page.getByRole('dialog', { name: 'Task tools', exact: true });
  await expect(tools.getByRole('button', { name: 'Diff', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await tools.getByRole('button', { name: 'Saved results', exact: true }).click();
  await expect(tools.getByRole('button', { name: 'Saved results', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(tools).toBeHidden();

  const meter = page.locator('.awContextMeter');
  await meter.click();
  const popup = page.locator('.awContextPopover');
  await expect(popup.getByText('Context composition')).toBeVisible();
  await expect(popup).toContainText('≈ 2,000');
  const anchor = (await meter.boundingBox())!;
  const panel = (await popup.boundingBox())!;
  expect(panel.y + panel.height).toBeLessThanOrEqual(anchor.y);
  expect(panel.x).toBeGreaterThanOrEqual(0);
  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();
});

test('navigation commits promptly while the visual transition settles', async ({ page }) => {
  await page.goto('/?setup=done&view=dashboard&lang=en');
  await expect(page.locator('.kShell')).toHaveAttribute('aria-busy', 'false');
  await page.evaluate(async () => {
    const path = '/src/lib/viewModules.ts';
    const { viewModules } = await import(/* @vite-ignore */ path);
    await viewModules.models();
  });
  const feedback = await page.evaluate(async () => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('.kNav button')].find(node => node.textContent?.trim() === 'Models')!;
    button.click();
    await new Promise(requestAnimationFrame);
    const main = document.querySelector('main')!;
    const style = getComputedStyle(main.querySelector('.modelsHub')!);
    return { selected: button.getAttribute('aria-current'), loading: !!main.querySelector('.routeLoading'), animation: style.animationName, duration: style.animationDuration, delay: style.animationDelay };
  });
  expect(feedback).toMatchObject({ selected: 'page', animation: 'kRouteEnter', duration: '0.38s', delay: '0s' });
  await expect(page.getByRole('tab', { name: 'Installed models', exact: true })).toBeVisible();
  const button = page.getByRole('navigation').getByRole('button', { name: 'Agents', exact: true });
  await button.hover();
  const box = (await button.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  expect(await button.evaluate(node => getComputedStyle(node).transitionDuration)).toBe('0.06s');
  await page.mouse.up();
});

test('reduced motion keeps navigation and typing immediate without animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?setup=done&view=chat&lang=en');
  await expect(page.locator('.kShell')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('main > .chatRoute')).toHaveCSS('animation-name', 'none');
  const input = page.getByRole('textbox', { name: 'Message to the model', exact: true });
  await expect(input).toBeEnabled();
  const draft = 'Instant input — проверка ввода — テキスト';
  await input.fill(draft);
  await expect(input).toHaveValue(draft);
  await expect(page.locator('.chatComposer')).toHaveCSS('transition-delay', '0s');
});
