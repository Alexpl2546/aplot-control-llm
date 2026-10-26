import { expect, test, type Page } from "@playwright/test";

const COPY = {
  en: {
    download: "Download model",
    dialogTitle: "Download a model",
    sourceLabel: "Public Hugging Face GGUF",
    dialogHelp: "Search a public Hugging Face repository, choose a complete GGUF variant, then prepare a download plan. Private or gated repositories are not supported.",
    source: "Public Hugging Face repository or file URL",
    find: "Find files",
    selectedFiles: "Selected files: 3",
    destination: "Destination folder",
    prepare: "Check folder and prepare plan",
    planReady: "Download plan ready",
    finalPath: "Demo / Models/demo-publisher-Demo-Chat-GGUF",
    enqueue: "Add to downloads",
    close: "Close",
    cancelDialog: "Cancel",
    pause: "Pause",
    resume: "Resume",
    cancel: "Cancel",
    remove: "Remove partial files",
    removeTitle: "Remove partial download files?",
    queued: "Queued",
    downloading: "Downloading",
    paused: "Paused",
    cancelled: "Cancelled",
    completed: "Completed",
    createProfile: "Create profile",
    createProfileTitle: "Choose a model and engine",
    createProfileHelp: "Choose a detected model and engine. Configuration opens for the selected model; saving the profile and starting a server are separate. A matching saved profile may open.",
    createProfileDemoNotice: "Browser demo: model files are not downloaded, so there is no installed model to configure.",
    chat: "Chat",
    library: "Models & Profiles",
    unpinMenu: "Collapse menu",
  },
  ru: {
    download: "Скачать модель",
    dialogTitle: "Скачать модель",
    sourceLabel: "Публичные GGUF с Hugging Face",
    dialogHelp: "Найдите файлы в публичном репозитории Hugging Face, выберите полный вариант GGUF и подготовьте план загрузки. Закрытые и gated-репозитории не поддерживаются.",
    source: "Публичный репозиторий Hugging Face или ссылка на файл",
    find: "Найти файлы",
    selectedFiles: "Выбрано файлов: 3",
    destination: "Папка назначения",
    prepare: "Проверить папку и подготовить план",
    planReady: "План загрузки готов",
    finalPath: "Demo / Models/demo-publisher-Demo-Chat-GGUF",
    enqueue: "Добавить в очередь",
    close: "Закрыть",
    cancelDialog: "Отмена",
    pause: "Пауза",
    resume: "Продолжить",
    cancel: "Отменить",
    remove: "Удалить временные файлы",
    removeTitle: "Удалить частичные файлы загрузки?",
    queued: "В очереди",
    downloading: "Скачивание",
    paused: "На паузе",
    cancelled: "Отменено",
    completed: "Завершено",
    createProfile: "Создать профиль",
    createProfileTitle: "Выберите модель и движок",
    createProfileHelp: "Выберите найденную модель и движок. Откроется конфигурация выбранной модели; сохранение профиля и запуск сервера выполняются отдельно. Если подходящий профиль уже есть, он откроется.",
    createProfileDemoNotice: "Демонстрационный режим в браузере: файлы не скачиваются, поэтому настроить установленную модель нельзя.",
    chat: "Чат",
    library: "Модели и профили",
    unpinMenu: "Свернуть меню",
  },
} as const;

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(dimensions.document, "document width should fit the viewport").toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.body, "body width should fit the viewport").toBeLessThanOrEqual(dimensions.viewport);
}

test('engine catalogs expose Strata variants and hand a Hub selection to the GGUF downloader', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.goto('/?setup=done&view=models&theme=dark&lang=ru');
  await expect(page.locator('.kShell')).toHaveAttribute('aria-busy', 'false', { timeout: 15_000 });
  await page.getByRole('button', { name: 'Скачать модель', exact: true }).click();
  const catalog = page.getByRole('dialog', { name: 'Скачать модель', exact: true });
  await catalog.getByRole('button', { name: 'Strata', exact: true }).click();
  await expect(catalog.locator('.modelCatalogCard')).toHaveCount(21);
  await expect(catalog.getByRole('checkbox', { name: 'Только подходящие по памяти', exact: true })).not.toBeChecked();
  await catalog.getByLabel('Фильтр моделей и квантований Strata', { exact: true }).fill('unsloth');
  await expect(catalog.locator('.modelCatalogCard')).toHaveCount(5);
  await page.screenshot({ path: 'e2e/screenshots/model-downloads-strata-catalog.png' });
  await catalog.getByRole('button', { name: 'llama.cpp', exact: true }).click();
  await catalog.getByLabel('Папка назначения', { exact: true }).fill('Demo / Chosen Models');
  await catalog.getByLabel('Найти модель по названию или автору', { exact: true }).fill('qwen');
  await expect(catalog.locator('.modelHubResult')).toHaveCount(2);
  await expectNoHorizontalOverflow(page);
  await catalog.getByRole('button', { name: 'Выбрать GGUF', exact: true }).first().click();
  const downloader = page.getByRole('dialog', { name: 'Скачать модель', exact: true });
  await expect(downloader.getByLabel('Публичный репозиторий Hugging Face или ссылка на файл')).toHaveValue('Qwen/Qwen3-4B-GGUF');
  await expect(downloader.getByLabel('Папка назначения', { exact: true })).toHaveValue('Demo / Chosen Models');
  await expect(downloader.locator('.modelDownloadRepository')).toContainText('Qwen/Qwen3-4B-GGUF');
  await expect(downloader.locator('input[name="model-download-variant"]:checked')).toHaveCount(1);
});

async function expectModalFitsViewport(page: Page, backdropSelector: string, dialogSelector: string) {
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const backdrop = page.locator(backdropSelector);
  const dialog = page.locator(dialogSelector);
  await expect(backdrop).toBeVisible();
  const backdropBox = await backdrop.boundingBox();
  const dialogBox = await dialog.boundingBox();
  expect(backdropBox, "modal backdrop should have a rendered box").not.toBeNull();
  expect(dialogBox, "modal dialog should have a rendered box").not.toBeNull();
  if (!backdropBox || !dialogBox) throw new Error("Modal is missing its rendered bounds");

  expect(backdropBox.x, "backdrop should start at the left viewport edge").toBeLessThanOrEqual(1);
  expect(backdropBox.y, "backdrop should start at the top viewport edge").toBeLessThanOrEqual(1);
  expect(backdropBox.x + backdropBox.width, "backdrop should cover the viewport width").toBeGreaterThanOrEqual(viewport.width - 1);
  expect(backdropBox.y + backdropBox.height, "backdrop should cover the viewport height").toBeGreaterThanOrEqual(viewport.height - 1);
  expect(dialogBox.x, "dialog should remain inside the left viewport edge").toBeGreaterThanOrEqual(0);
  expect(dialogBox.y, "dialog should remain inside the top viewport edge").toBeGreaterThanOrEqual(0);
  expect(dialogBox.x + dialogBox.width, "dialog should remain inside the right viewport edge").toBeLessThanOrEqual(viewport.width + 1);
  expect(dialogBox.y + dialogBox.height, "dialog should remain inside the bottom viewport edge").toBeLessThanOrEqual(viewport.height + 1);
}

for (const locale of ["en", "ru"] as const) {
  const copy = COPY[locale];

  test(`model downloads in ${locale}: dialog, queue controls, and responsive layout`, async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 720 });
    await page.goto(`/?setup=done&view=models&theme=dark&lang=${locale}`);
    await expect(page.locator(".kShell")).toHaveAttribute("aria-busy", "false", { timeout: 15_000 });
    const libraryNav = page.locator(".kNav button").filter({ hasText: copy.library });
    await expect(libraryNav).toHaveClass(/isOn/);
    await expect(page.locator("#main-content .routeLoading")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByRole("heading", { name: copy.library, exact: true })).toBeVisible();

    const sidebar = page.locator(".kSidebar");
    await sidebar.getByRole("button", { name: copy.unpinMenu, exact: true }).click();
    await page.mouse.move(1050, 700);
    await expect(sidebar).toHaveClass(/isRail/);

    const openDownload = page.getByRole("button", { name: copy.download, exact: true });
    await openDownload.click();
    await page.getByRole("button",{name:locale==="ru"?"Расширенный режим: ссылка на GGUF":"Advanced: GGUF URL",exact:true}).click();

    const dialog = page.getByRole("dialog", { name: copy.dialogTitle, exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(copy.sourceLabel, { exact: true })).toBeVisible();
    await expect(dialog.getByText(copy.dialogHelp, { exact: true })).toBeVisible();
    const source = dialog.getByLabel(copy.source, { exact: true });
    await expect(source).toBeFocused();

    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("button", { name: copy.close, exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("button", { name: copy.cancelDialog, exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: copy.close, exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(openDownload).toBeFocused();

    await openDownload.click();
    await page.getByRole("button",{name:locale==="ru"?"Расширенный режим: ссылка на GGUF":"Advanced: GGUF URL",exact:true}).click();
    const reopenedDialog = page.getByRole("dialog", { name: copy.dialogTitle, exact: true });
    const sourceInput = reopenedDialog.getByLabel(copy.source, { exact: true });
    await sourceInput.fill("demo-publisher/Demo-Chat-GGUF");
    await reopenedDialog.getByRole("button", { name: copy.find, exact: true }).click();

    await reopenedDialog.locator('input[name="model-download-variant"][value="demo-q4-split"]').check();
    await reopenedDialog.locator('input[name="model-download-mmproj"][value="demo-chat-mmproj-f16.gguf"]').check();
    await expect(reopenedDialog.getByText(copy.selectedFiles, { exact: false })).toBeVisible();
    await expect(reopenedDialog.getByLabel(copy.destination, { exact: true })).toHaveValue("Demo / Models");

    await reopenedDialog.getByRole("button", { name: copy.prepare, exact: true }).click();
    await expect(reopenedDialog.getByRole("status").getByText(copy.planReady, { exact: true })).toBeVisible();
    await expect(reopenedDialog.getByText(copy.finalPath, { exact: true })).toBeVisible();
    await reopenedDialog.getByRole("button", { name: copy.enqueue, exact: true }).click();
    await expect(reopenedDialog).toBeHidden();

    const task = page.locator(".downloadTask").filter({ hasText: "demo-publisher/Demo-Chat-GGUF" });
    await expect(task).toBeVisible();
    await expect(task.getByText(copy.queued, { exact: true })).toBeVisible();
    await task.getByRole("button", { name: copy.pause, exact: true }).click();
    await expect(task.getByText(copy.paused, { exact: true })).toBeVisible();

    await page.keyboard.press("Escape");
    await page.locator(".kNav button").filter({ hasText: copy.chat }).click();
    await expect(page.locator(".kNav button").filter({ hasText: copy.chat })).toHaveClass(/isOn/);
    await page.locator(".kNav button").filter({ hasText: copy.library }).click();
    await expect(page.locator(".kNav button").filter({ hasText: copy.library })).toHaveClass(/isOn/);
    await page.locator(".toolbar button").filter({hasText:locale==="ru"?"Загрузки":"Downloads"}).click();
    await expect(task.getByText(copy.paused, { exact: true })).toBeVisible();
    await page.mouse.move(1050, 700);
    await expect(sidebar).toHaveClass(/isRail/);

    await task.getByRole("button", { name: copy.resume, exact: true }).click();
    await expect(task.getByText(copy.downloading, { exact: true })).toBeVisible();
    await expect(task.locator("progress")).toHaveAttribute("value", "42");
    await task.getByRole("button", { name: copy.cancel, exact: true }).click();
    await expect(task.getByText(copy.cancelled, { exact: true })).toBeVisible();
    await expect(task.locator("progress")).toHaveAttribute("value", "42");

    await task.getByRole("button", { name: copy.remove, exact: true }).click();
    const removeDialog = page.locator(".confirmDialog");
    await expect(removeDialog).toBeVisible();
    await expectModalFitsViewport(page, "body > .modalBackdrop:has(.confirmDialog)", ".confirmDialog");
    await expect(removeDialog.getByText(copy.removeTitle, { exact: true })).toBeVisible();
    await removeDialog.getByRole("button", { name: copy.remove, exact: true }).click();
    await expect(task.getByText(copy.cancelled, { exact: true })).toBeVisible();
    await expect(task.locator("progress")).toHaveAttribute("value", "0");

    await task.getByRole("button", { name: copy.resume, exact: true }).click();
    await expect(task.getByText(copy.completed, { exact: true })).toBeVisible({ timeout: 10_000 });
    await expectNoHorizontalOverflow(page);

    await task.getByRole("button", { name: copy.createProfile, exact: true }).click();
    const createProfileDialog = page.getByRole("dialog", { name: copy.createProfileTitle, exact: true });
    const createProfileClose = createProfileDialog.getByRole("button", { name: copy.close, exact: true });
    const createProfileCancel = createProfileDialog.getByRole("button", { name: copy.cancelDialog, exact: true });
    await expect(createProfileClose).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(createProfileCancel).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(createProfileClose).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(createProfileCancel).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(createProfileClose).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(createProfileDialog).toBeHidden();
    await expect(task.getByRole("button", { name: copy.createProfile, exact: true })).toBeFocused();

    await task.getByRole("button", { name: copy.createProfile, exact: true }).click();
    await expect(createProfileDialog.getByText(copy.createProfileHelp, { exact: true })).toBeVisible();
    await expect(createProfileDialog.getByText(copy.createProfileDemoNotice, { exact: true })).toBeVisible();
    await expectModalFitsViewport(page, "body > .modalBackdrop:has(.downloadProfileDialog)", ".downloadProfileDialog");
    await expect(page.getByRole("heading", { name: copy.library, exact: true })).toBeVisible();
    if (locale === "en") {
      await page.screenshot({ path: "e2e/screenshots/model-download-profile-dialog-1100x720.png" });
    }
    await createProfileCancel.click();
    await expect(createProfileDialog).toBeHidden();

    if (locale === "en") {
      await page.screenshot({ path: "e2e/screenshots/model-downloads-1100x720.png", fullPage: true });
    }

    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.mouse.move(1800, 1040);
    await expectNoHorizontalOverflow(page);

    if (locale === "en") {
      await page.screenshot({ path: "e2e/screenshots/model-downloads-1920x1080.png", fullPage: true });
    }
  });
}
