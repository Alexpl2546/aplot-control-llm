import { test, expect, type Page } from '@playwright/test';
async function bounds(page:Page){
 const popup=page.locator('.aplotSelectPositioner');await expect(popup).toBeVisible();await expect(popup.locator('.aplotSelectPopup')).toHaveCSS('opacity','1');
 const box=await popup.boundingBox();const viewport=page.viewportSize()!;expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.y).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(viewport.width+1);expect(box!.y+box!.height).toBeLessThanOrEqual(viewport.height+1);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
}
for(const [width,height] of [[1920,1080],[1440,900],[1280,800],[1100,720]])for(const theme of ['dark','light'])for(const lang of ['ru','en']){
 test(`modal ${width}x${height} ${theme} ${lang}`,async({page})=>{
  await page.setViewportSize({width,height});await page.goto(`/?setup=done&view=settings&theme=${theme}&lang=${lang}`);
  const trigger=page.getByRole('combobox',{name:lang==='ru'?'Тема':'Theme',exact:true});await trigger.click();await bounds(page);
  await page.keyboard.press('End');await page.keyboard.press('Enter');await expect(trigger).toContainText(lang==='ru'?'Как в системе':'Use system setting');
  await trigger.click();await page.keyboard.press('Escape');await expect(page.getByRole('listbox')).toHaveCount(0);await expect(page.getByRole('dialog')).toBeVisible();await expect(trigger).toBeFocused();
 });
}
test('model finder: metadata, no results, clear, keyboard, native handler and persistence',async({page})=>{
 await page.goto('/?setup=done&view=configuration&lang=ru');await page.locator('#configuration-engine-tab').click();const trigger=page.getByRole('combobox',{name:'Профиль',exact:true});await trigger.click();await bounds(page);
 const search=page.locator('.aplotSelectSearch input');await search.fill('128k');await expect(page.getByRole('option')).toHaveCount(1);await expect(page.getByRole('option')).toContainText('Long context');
 await search.fill('zz-no-model');await expect(page.getByRole('option')).toHaveCount(0);await expect(page.getByRole('status').filter({hasText:/не найдено|No/})).toBeVisible();await page.getByRole('button',{name:'Очистить поиск'}).click();await expect(page.getByRole('option')).toHaveCount(3);
 await search.fill('Long context');await search.press('ArrowDown');await search.press('Enter');await expect(trigger).toContainText('Long context');await page.getByRole('button',{name:'Логи',exact:true}).click();await page.getByRole('button',{name:'Параметры запуска',exact:true}).click();await page.locator('#configuration-engine-tab').click();await expect(page.getByRole('combobox',{name:'Профиль',exact:true})).toContainText('Long context');
});
test('Smart Task descriptive rows use the original preset state',async({page})=>{
 await page.goto('/?setup=done&view=configuration&lang=ru');await page.getByRole('combobox',{name:'Сценарий',exact:true}).click();await bounds(page);await expect(page.locator('.aplotSelectOptionIcon')).toHaveCount(3);await expect(page.locator('.aplotSelectOptionText small')).toHaveCount(3);await page.getByRole('option',{name:/Быстрая правка/}).click();await expect(page.getByRole('combobox',{name:'Сценарий',exact:true})).toContainText('Быстрая правка');
});
test('chat composer flips upward at right edge and does not scroll the page',async({page})=>{
 await page.setViewportSize({width:1100,height:720});await page.goto('/?setup=done&view=chat&lang=ru');await page.getByRole('button',{name:'ChatGPT',exact:true}).click();const trigger=page.getByRole('combobox',{name:'Модель',exact:true});await trigger.click();await bounds(page);const field=await trigger.boundingBox(),popup=await page.locator('.aplotSelectPositioner').boundingBox();expect(popup!.y+popup!.height).toBeLessThanOrEqual(field!.y+1);const scroll=await page.evaluate(()=>document.scrollingElement!.scrollTop);await page.locator('.aplotSelectSearch input').press('End');await page.mouse.move(popup!.x+100,popup!.y+80);await page.mouse.wheel(0,400);expect(await page.evaluate(()=>document.scrollingElement!.scrollTop)).toBe(scroll);await page.keyboard.press('Escape');
});
test('CSS interface zoom, modal top layer, reduced motion and theme switching',async({page})=>{
 await page.setViewportSize({width:1280,height:800});await page.emulateMedia({reducedMotion:'reduce'});await page.goto('/?setup=done&view=settings&lang=ru');await page.getByRole('combobox',{name:'Масштаб интерфейса',exact:true}).click();await page.getByRole('option',{name:'140%',exact:true}).click();const trigger=page.getByRole('combobox',{name:'Тема',exact:true});await trigger.click();await bounds(page);expect(await page.locator('.aplotSelectPositioner').evaluate(el=>el.matches(':popover-open'))).toBe(true);await page.getByRole('option',{name:'Светлая',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','light');await trigger.click();await bounds(page);await page.keyboard.press('Escape');
});
test('long profile catalogue: wheel, retained scroll, keyboard reveal, resize',async({page})=>{
 await page.route('**/src/mocks/runtime.ts*',async route=>{const response=await route.fetch();await route.fulfill({response,body:await response.text()+`
MOCK_PROFILES.push(...Array.from({length:997},(_,i)=>({...MOCK_PROFILES[0],id:'qa-'+i,name:'Длинное имя модели и профиля '+i,config:{...MOCK_PROFILES[0].config,profileId:'qa-'+i}})));`});});
 await page.goto('/?setup=done&view=configuration&lang=ru');await page.locator('#configuration-engine-tab').click();await expect(page.getByRole('combobox',{name:'Профиль',exact:true})).toContainText('Example');
 const trigger=page.getByRole('combobox',{name:'Профиль',exact:true});await trigger.click();await bounds(page);await expect(page.getByRole('option')).toHaveCount(1000);const list=page.getByRole('listbox');await list.hover();await page.mouse.wheel(0,500);await expect.poll(()=>list.evaluate(el=>el.scrollTop)).toBeGreaterThan(100);const scroll=await list.evaluate(el=>el.scrollTop);await page.keyboard.press('Escape');await expect(list).toHaveCount(0);await trigger.click();await expect.poll(()=>page.getByRole('listbox').evaluate(el=>el.scrollTop)).toBe(scroll);await page.locator('.aplotSelectSearch input').press('ArrowDown');await page.locator('.aplotSelectSearch input').press('End');await page.locator('.aplotSelectSearch input').press('ArrowDown');await page.setViewportSize({width:1100,height:720});await bounds(page);await page.keyboard.press('Escape');
});

test('profile deletion confirmation traps focus, closes with Escape and restores the opener',async({page})=>{
 await page.goto('/?setup=done&view=profiles&lang=en');
 const opener=page.getByRole('button',{name:'Delete',exact:true}).first();await opener.click();
 const dialog=page.getByRole('dialog',{name:'Delete profile?',exact:true});await expect(dialog).toBeVisible();
 await expect(dialog.getByRole('button',{name:'Cancel',exact:true})).toBeFocused();
 await page.keyboard.press('Shift+Tab');await expect(dialog.getByRole('button',{name:'Close',exact:true})).toBeFocused();
 await page.keyboard.press('Shift+Tab');await expect(dialog.getByRole('button',{name:'Delete',exact:true})).toBeFocused();
 await page.keyboard.press('Tab');await expect(dialog.getByRole('button',{name:'Close',exact:true})).toBeFocused();
 await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(opener).toBeFocused();
 await opener.click();await dialog.click({position:{x:4,y:4}});await expect(dialog).toHaveCount(0);await expect(opener).toBeFocused();
});

for(const view of ['configuration','performance','models','logs','apiDocs','settings'])test(`screen dropdown audit: ${view}`,async({page})=>{
 await page.goto(`/?setup=done&view=${view}&lang=ru`);if(view==='configuration')await page.locator('#configuration-engine-tab').click();if(view==='performance')await page.locator('.deskTabs button').last().click();
 await expect(page.locator('main')).toBeVisible();const fields=page.locator('.aplotSelectTrigger:visible');await expect.poll(()=>fields.count()).toBeGreaterThan(0);
 const count=await fields.count();for(let i=0;i<count;i++){const field=fields.nth(i);if(await field.isDisabled())continue;await expect(field).toHaveAttribute('aria-label',/.+/);await field.click();await bounds(page);await page.keyboard.press('Escape');await expect(page.getByRole('listbox')).toHaveCount(0);}
 expect(await page.locator('select:not(.aplotSelectNative)').count()).toBe(0);
});
