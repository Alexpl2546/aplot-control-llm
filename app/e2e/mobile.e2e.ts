import { expect, test, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = path.resolve(appRoot, '..');
const screenshots = path.join(appRoot, 'artifacts/mobile');
let directory: string;
let home: string;
let token: string;
let origin: string;
let server: ChildProcess | undefined;

function command(program: string, args: string[], cwd = repoRoot): string {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 180_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(program)} failed: ${result.stderr.slice(0, 1000)}`);
  return result.stdout;
}

async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20_000;
  do {
    const value = await read();
    if (ready(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error('Mobile fixture state did not converge');
}

async function api(route: string) {
  const response = await fetch(origin + '/api/v1' + route, { headers: { Authorization: `Bearer ${token}` } });
  expect(response.status).toBe(200);
  return response.json();
}

async function login(page: Page) {
  await page.goto(origin + '/mobile/');
  await page.locator('#access-token').fill(token);
  await page.getByRole('button', { name: 'Подключиться', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Проекты и задачи' })).toBeVisible();
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  if (!fs.existsSync(path.join(appRoot, 'dist-mobile/index.html'))) throw new Error('Run npm run build:mobile before the browser test');
  command('cargo', ['build', '--locked', '--manifest-path', 'crates/aplot-server/Cargo.toml']);
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aplot-mobile-e2e-'));
  home = path.join(directory, 'isolated-home');
  const projectRoot = path.join(directory, 'project');
  const data = path.join(directory, 'server');
  fs.mkdirSync(home);
  fs.mkdirSync(projectRoot);
  fs.writeFileSync(path.join(projectRoot, 'README.md'), 'Mobile client fixture. No real inference.\n');
  fs.writeFileSync(path.join(home, 'fixture-mode'), 'hang');
  const fixture = path.join(directory, process.platform === 'win32' ? 'codex-fixture.exe' : 'codex-fixture');
  command('rustc', ['--edition=2021', 'crates/aplot-server/tests/fixtures/codex_app_server.rs', '-o', fixture]);
  const binary = path.join(repoRoot, 'crates/aplot-server/target/debug', process.platform === 'win32' ? 'aplotd.exe' : 'aplotd');
  command(binary, ['--data-dir', data, '--register-project', projectRoot, '--name', 'Мобильный пилот']);
  const initialization = command(binary, ['--data-dir', data, '--init-mobile-token']);
  token = fs.readFileSync(path.join(data, 'mobile-access.token'), 'utf8').trim();
  expect(initialization).not.toContain(token);
  fs.mkdirSync(screenshots, { recursive: true });
  server = spawn(binary, [
    '--data-dir', data, '--mobile', '--listen', '127.0.0.1:0',
    '--mobile-assets', path.join(appRoot, 'dist-mobile'),
    '--codex-executable', fixture, '--codex-home', home, '--model', 'test-model', '--timeout-seconds', '30',
  ], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  origin = await new Promise<string>((resolve, reject) => {
    let output = '', error = '';
    const timer = setTimeout(() => reject(new Error('Mobile server startup timed out')), 10_000);
    server!.stderr!.on('data', chunk => { error += String(chunk); });
    server!.stdout!.on('data', chunk => {
      output += String(chunk);
      for (const line of output.split('\n')) {
        try {
          const event = JSON.parse(line);
          if (event.event === 'listening' && event.mobileUrl) {
            clearTimeout(timer);
            resolve(new URL(event.mobileUrl).origin);
          }
        } catch { /* Wait for a complete line. */ }
      }
    });
    server!.on('exit', code => { clearTimeout(timer); reject(new Error(`Mobile server exited (${code}): ${error.slice(0, 1000)}`)); });
  });
});

test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise<void>(resolve => server!.once('exit', () => resolve()));
    server.kill();
    await exited;
  }
  if (directory) {
    const absolute = path.resolve(directory);
    const parent = path.resolve(os.tmpdir()) + path.sep;
    if (!absolute.startsWith(parent) || !path.basename(absolute).startsWith('aplot-mobile-e2e-')) throw new Error('Unexpected mobile fixture cleanup path');
    fs.rmSync(absolute, { recursive: true, force: true });
  }
});

test('phone creates and runs a durable task, stops it, retries a lost reply and keeps private data out of caches', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  let page = await context.newPage();
  const failures: string[] = [];
  context.on('page', p => p.on('pageerror', error => failures.push(error.message)));
  page.on('pageerror', error => failures.push(error.message));
  await page.goto(origin + '/mobile/');
  await page.screenshot({ path: path.join(screenshots, 'phone-connect.png') });
  await login(page);
  await expect(page.locator('#project-select')).toHaveValue(/.+/);
  await expect(page.locator('#project-select')).toContainText('Мобильный пилот');
  await page.locator('#new-task-title').fill('Проверка с телефона');
  const creation = page.waitForResponse(response => response.request().method() === 'POST' && /\/projects\/[^/]+\/tasks$/.test(response.url()));
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  const receipt = await (await creation).json();
  expect(receipt.status).toBe('created');
  const taskId: string = receipt.taskId;
  await expect(page.getByRole('heading', { name: 'Проверка с телефона' })).toBeVisible();
  await expect(page.getByText('Начните задачу сообщением ниже.')).toBeVisible();
  await page.getByRole('button', { name: 'Параметры задачи', exact: true }).click();
  const options = page.getByRole('dialog', { name: 'Параметры задачи' });
  await expect(options.getByRole('button', { name: /^Полный доступ/ })).toBeEnabled();
  await options.getByRole('button', { name: /^Полный доступ/ }).click();
  const grant = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/tasks/${taskId}/access`));
  await options.getByRole('button', { name: 'Разрешить полный доступ' }).click();
  expect((await grant).status()).toBe(200);
  await expect(options.getByText('полный доступ', { exact: true })).toBeVisible();
  expect((await api(`/tasks/${taskId}`)).metadata.accessMode).toBe('full');
  await options.getByRole('button', { name: /^Только чтение/ }).click();
  await expect(options.getByText('только чтение', { exact: true })).toBeVisible();
  expect((await api(`/tasks/${taskId}`)).metadata.accessMode).toBe('restricted');
  await options.getByRole('button', { name: 'Закрыть параметры задачи' }).click();
  const composer = () => page.locator('#message-draft');
  await composer().fill('Первое сообщение с телефона');
  await page.getByRole('button', { name: 'Отправить сообщение' }).click();
  await waitFor(() => api(`/tasks/${taskId}`), value => value.task.state.pending && value.task.state.nativeGeneration);
  await composer().fill('Черновик следующего сообщения');
  await expect(composer()).toHaveValue('Черновик следующего сообщения');
  await page.waitForTimeout(1100);
  await expect(composer()).toHaveValue('Черновик следующего сообщения');
  await page.close(); // Client disconnection must not stop server-owned work.
  expect((await api(`/tasks/${taskId}`)).task.state.pending).toBe(true);
  page = await context.newPage();
  await login(page);
  await page.getByRole('button', { name: 'Открыть задачу Проверка с телефона' }).click();
  await page.getByRole('button', { name: /^(Стоп|Остановить)$/ }).click();
  await waitFor(() => api(`/tasks/${taskId}`), value => !value.task.state.pending && value.commands.some((c: any) => c.status === 'interrupted'));
  fs.writeFileSync(path.join(home, 'fixture-mode'), 'mobile-demo');
  await composer().fill('Получить тестовый ответ');
  const messagesUrl = origin + `/api/v1/tasks/${taskId}/messages`;
  let releaseReads!: () => void;
  const readGate = new Promise<void>(resolve => { releaseReads = resolve; });
  let holdReads = true;
  const taskUrl = origin + `/api/v1/tasks/${taskId}`;
  await page.route(taskUrl, async route => {
    const response = await route.fetch();
    if (holdReads) await readGate;
    await route.fulfill({ response });
  });
  const sent: unknown[] = [];
  let loseReply = true;
  await page.route(messagesUrl, async route => {
    sent.push(route.request().postDataJSON());
    const response = await route.fetch(); // Real server accepts it before the reply is lost.
    if (loseReply) { loseReply = false; await route.abort('failed'); }
    else await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Отправить сообщение' }).click();
  await expect(page.getByRole('button', { name: 'Повторить', exact: true })).toBeVisible();
  await composer().fill('Новый черновик останется после повтора');
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[0]).toEqual(sent[1]);
  holdReads = false;
  releaseReads();
  await page.unroute(messagesUrl);
  await waitFor(() => api(`/tasks/${taskId}`), value => !value.task.state.pending && value.task.messages.some((m: any) => m.text?.includes('Тестовый ответ локального имитатора')));
  await expect(page.getByText(/Тестовый ответ локального имитатора/)).toBeVisible();
  await expect(composer()).toHaveValue('Новый черновик останется после повтора');
  const persisted = await api(`/tasks/${taskId}`);
  expect(persisted.task.messages.filter((m: any) => m.kind === 'user' && m.text === 'Получить тестовый ответ')).toHaveLength(1);
  await page.getByRole('button', { name: 'Вернуться к списку задач' }).click();
  await expect(page.getByRole('heading', { name: 'Проекты и задачи' })).toBeVisible();
  await page.screenshot({ path: path.join(screenshots, 'phone-projects-390.png') });
  await page.getByRole('button', { name: 'Открыть задачу Проверка с телефона' }).click();
  await expect(page.getByText(/Тестовый ответ локального имитатора/)).toBeVisible();
  await expect(composer()).toHaveValue('Новый черновик останется после повтора');
  await page.screenshot({ path: path.join(screenshots, 'phone-chat-390.png') });
  for (const [width, height] of [[360, 800], [844, 390], [390, 430], [390, 320]]) {
    await page.setViewportSize({ width, height });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect.poll(async () => {
      const box = await composer().boundingBox();
      return box ? box.y + box.height : Number.POSITIVE_INFINITY;
    }).toBeLessThanOrEqual(height + 1);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  const cacheUrls = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) {
        if (request.headers.has('Authorization')) throw new Error('Credential-bearing request was cached');
        urls.push(request.url);
      }
    }
    return urls;
  });
  expect(cacheUrls.length).toBeGreaterThan(0);
  expect(cacheUrls.every(url => new URL(url).pathname.startsWith('/mobile/'))).toBe(true);
  expect(cacheUrls.some(url => url.includes('/api/'))).toBe(false);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#access-token')).toBeVisible();
  await expect(page.getByText('Получить тестовый ответ', { exact: true })).toHaveCount(0);
  await context.setOffline(false);
  expect(failures).toEqual([]);
  await context.close();
});

test.describe('WebKit mobile commands', () => {
  test('creates a task with the actual origin despite the public shell no-referrer policy', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    try {
      await login(page);
      await page.locator('#new-task-title').fill('Проверка создания задачи в WebKit');
      const creation = page.waitForResponse(response => response.request().method() === 'POST' && /\/projects\/[^/]+\/tasks$/.test(response.url()));
      await page.getByRole('button', { name: 'Создать', exact: true }).click();
      const response = await creation;
      expect(response.request().headers().origin).toBe(origin);
      expect(response.status()).toBe(201);
      await expect(page.getByRole('heading', { name: 'Проверка создания задачи в WebKit' })).toBeVisible();
      expect(await page.getByRole('alert').allTextContents()).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
