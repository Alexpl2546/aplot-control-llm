import { test, expect } from '@playwright/test';

const originalName = 'Тестировщик_Джуниор_Локальный_' + 'ДлинноеИмя'.repeat(4);
async function openSettings(page: import('@playwright/test').Page) {
  await page.addInitScript(name => localStorage.setItem('aplot-agent-workspace-v2-preview', JSON.stringify({ version: 2, revision: 0, data: { agentDirectoryVersion: 1, presets: [{id:'reviewer',name,runtime:'codex',accessMode:'full',instructions:''}], projects:[],tasks:[],memory:[],threads:{} } })), originalName);
  await page.goto('/?setup=done&view=chat&lang=ru');
  await expect(page.locator('.kShell')).toHaveAttribute('aria-busy','false');
  await page.locator('.deskAgentRow').click({button:'right'});
  await page.getByRole('menuitem',{name:'Переименовать',exact:true}).click();
  return page.getByRole('dialog',{name:'Настройки',exact:true});
}
for(const width of [1100,1440,1920]) test(`agent rename, visible labels, bounded name at ${width}`,async({page})=>{
  await page.setViewportSize({width,height:900});
  const dialog=await openSettings(page);
  const input=dialog.getByLabel('Имя агента',{exact:true});
  await expect(input).toBeFocused();
  await expect(dialog.locator('.oaPresetField').filter({hasText:'Нет доступных моделей'})).toBeVisible();
  await expect(dialog.getByLabel('Модель', {exact:true})).toBeDisabled();
  const aside=dialog.locator('.oaPresetLayout aside');
  expect(await aside.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  expect(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  await input.fill('Старший тестировщик');
  await dialog.getByRole('button',{name:'Сохранить',exact:true}).click();
  await expect(dialog.getByRole('status')).toHaveText('Сохранено');
  await expect(aside.getByRole('button',{name:'Старший тестировщик',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('aplot-agent-workspace-v2-preview')!).data.presets[0].name)).toBe('Старший тестировщик');
});

test('default context menu selects text and inputs; feature menus take precedence',async({page})=>{
  await page.goto('/?setup=done&view=chat&lang=ru');
  await expect(page.locator('.kShell')).toHaveAttribute('aria-busy','false');
  const input=page.locator('.chatComposer textarea');
  await input.fill('Проверка полного выделения');
  await input.click({button:'right'});
  await expect(page.getByRole('menuitem')).toHaveText(['Выбрать всё']);
  await page.getByRole('menuitem',{name:'Выбрать всё'}).click();
  expect(await input.evaluate((node:HTMLTextAreaElement)=>[node.selectionStart,node.selectionEnd,node.value.length])).toEqual([0,26,26]);
  await page.locator('main h2').first().click({button:'right'});
  await page.getByRole('menuitem',{name:'Выбрать всё'}).click();
  expect(await page.evaluate(()=>window.getSelection()?.toString().length)).toBeGreaterThan(30);
  const dialog=await openSettings(page);
  await dialog.getByLabel('Имя агента',{exact:true}).click({button:'right'});
  await expect(page.locator('.defaultContextMenu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(page.locator('.defaultContextMenu')).toHaveCount(0);
});

test('provider headers open their own profile management',async({page})=>{
  await page.goto('/?setup=done&view=dashboard&lang=ru');
  for (const provider of ['Codex','Claude']) {
    await page.locator('.oaProviderManage').getByText(provider,{exact:true}).click();
    const dialog=page.getByRole('dialog',{name:new RegExp(`^${provider} ·`)});
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button',{name:'Добавить профиль',exact:true}).click();
    await expect(dialog.getByLabel('Среда',{exact:true})).toHaveText(provider==='Codex'?'ChatGPT':'Claude Code');
    await expect(dialog.getByLabel('Среда',{exact:true})).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  }
});

test('notifications open, retain dismissed toasts, and can be cleared',async({page})=>{
 await page.goto('/?setup=done&view=dashboard&lang=ru');
 await expect(page.locator('.kShell')).toHaveAttribute('aria-busy','false');
 await page.getByRole('button',{name:'Уведомления',exact:true}).click();
 await expect(page.getByText('Уведомлений пока нет',{exact:true})).toBeVisible();
 await page.keyboard.press('Escape');
 await page.evaluate(async()=>{const path=performance.getEntriesByType('resource').map(x=>x.name).find(x=>/\/src\/store\/control\.ts(?:\?|$)/.test(x))!;const {useControlStore}=await import(/* @vite-ignore */ path);useControlStore.getState().notify('info','Saved test notification');});
 await expect(page.locator('.toast')).toContainText('Saved test notification');
 await page.locator('.toast button').click();
 await page.getByRole('button',{name:'Уведомления',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Уведомления',exact:true});
 await expect(dialog).toContainText('Saved test notification');
 await dialog.getByRole('button',{name:'Очистить уведомления',exact:true}).click();
 await expect(dialog.getByText('Уведомлений пока нет',{exact:true})).toBeVisible();
});
for(const [width,height]of [[1100,720],[1280,800],[1440,900],[1920,1080]])for(const scale of [1,1.25,1.5])test(`settings fit ${width}x${height}, scale ${scale}`,async({page})=>{
 await page.setViewportSize({width,height});
 await page.goto('/?setup=done&view=dashboard&lang=ru');
 await expect(page.locator('.kShell')).toHaveAttribute('aria-busy','false');
 await page.evaluate(async(scale)=>{const path=performance.getEntriesByType('resource').map(x=>x.name).find(x=>/\/src\/store\/control\.ts(?:\?|$)/.test(x))!;const {useControlStore}=await import(/* @vite-ignore */ path);useControlStore.setState(s=>({settingsOpen:true,settingsSection:'engine',settings:{...s.settings,serverEngine:'strata',uiScale:scale,strataRootPath:'C:/Users/Example/Very long installation folder/components/strata/0.1.47'}}));},scale);
 const dialog=page.getByRole('dialog',{name:'Настройки',exact:true});
 await expect(dialog).toBeVisible();
 for(const section of ['Движки и модели','Общие','Подписки и подключения','Настроенные агенты']){
  await dialog.locator('.settingsWindowNav').getByRole('button',{name:section,exact:true}).click();
  const sizes=await dialog.evaluate(node=>({x:node.getBoundingClientRect().x,right:node.getBoundingClientRect().right,bottom:node.getBoundingClientRect().bottom,overflow:node.scrollWidth-node.clientWidth,contentOverflow:node.querySelector('.settingsWindowContent')!.scrollWidth-node.querySelector('.settingsWindowContent')!.clientWidth}));
  expect(sizes.x).toBeGreaterThanOrEqual(0);expect(sizes.right).toBeLessThanOrEqual(width+1);expect(sizes.bottom).toBeLessThanOrEqual(height+1);expect(sizes.overflow).toBeLessThanOrEqual(2);expect(sizes.contentOverflow).toBeLessThanOrEqual(2);
 }
});

test('model catalogue separates engines, filters memory, and keeps downloads out of the library',async({page})=>{
 await page.setViewportSize({width:1100,height:720});
 await page.goto('/?setup=done&view=models&lang=ru');
 await expect(page.locator('.kShell')).toHaveAttribute('aria-busy','false');
 await expect(page.locator('.downloadsPanel')).toHaveCount(0);
 await page.getByRole('button',{name:'Скачать модель',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Скачать модель',exact:true});
 await expect(dialog.locator('.modelCatalogCard')).toHaveCount(3);
 await dialog.getByRole('button',{name:'Strata',exact:true}).click();
 await dialog.getByLabel('Только подходящие по памяти',{exact:true}).uncheck();
 await expect(dialog.locator('.modelCatalogCard')).toHaveCount(3);
 await expect(dialog).toContainText('токенизатора');
 await page.keyboard.press('Escape');
 await expect(dialog).toBeHidden();
 await page.getByRole('button',{name:'Скачать модель',exact:true}).click();
 await page.getByRole('dialog',{name:'Скачать модель',exact:true}).getByRole('button',{name:'Скачать и подготовить',exact:true}).first().click();
 await expect(page.locator('.downloadsPanel')).toBeVisible();
 await expect(page.locator('.downloadTask').first()).toContainText('Qwen/Qwen3-4B-GGUF');
 await page.keyboard.press('Escape');
 await expect(page.locator('.downloadsPanel')).toHaveCount(0);
});
