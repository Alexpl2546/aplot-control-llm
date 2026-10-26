import {test,expect,type Page} from '@playwright/test';
async function settings(page:Page){
 const button=page.getByRole('button',{name:'Настройки проекта',exact:true,includeHidden:true});await expect(button).toBeAttached();if(!await button.isVisible())await page.locator('.awTaskToggle').click();await button.click();return page.getByRole('dialog',{name:'Настройки проекта',exact:true});
}
async function seed(page:Page){
 // Browser has no filesystem bridge. Stub only folder validation; persistence,
 // UI, store and history use the real application modules.
 await page.route('**/src/services/agentWorkspace.ts*',async route=>{
  const response=await route.fetch();const source=await response.text();
  const body=source.replace(/(export async function validateWorkspaceFolder\(path\) \{)[\s\S]*?\n\}/,'$1\n if(path.includes("missing")) throw new Error("folder"); return path;\n}');
  expect(body).not.toBe(source);await route.fulfill({response,body});
 });
 await page.addInitScript(()=>{if(localStorage.getItem('paths-seeded'))return;localStorage.setItem('paths-seeded','1');localStorage.setItem('aplot-agent-workspace-v2-preview',JSON.stringify({version:2,revision:0,data:{agentDirectoryVersion:1,projects:[{id:'p',name:'workspace',path:'C:\\missing\\workspace',skills:'',createdAt:1}],tasks:[{id:'t',projectId:'p',title:'Task',archived:false,unread:false,createdAt:1,updatedAt:1}],memory:[],presets:[],threads:{t:{cwd:'C:\\missing\\workspace',entries:[{id:'m',kind:'user',text:'Keep this history'}]}},selectedProjectId:'p',selectedTaskId:'t'}}));});
 await page.goto('/?setup=done&view=agentWorkspace&lang=ru');await expect(page.locator('.agentWorkspaceV2')).toBeVisible();return settings(page);
}
for(const width of [1100,1920])test(`relink folder and retain conversation after reload at ${width}`,async({page})=>{
 await page.setViewportSize({width,height:800});let dialog=await seed(page);const path=dialog.getByRole('textbox',{name:'Папка проекта',exact:true});await path.fill('C:\\new\\рабочая папка');
 await dialog.getByRole('button',{name:'Сохранить',exact:true}).click();await expect(dialog).toBeHidden();await page.reload();dialog=await settings(page);await expect(dialog.getByRole('textbox',{name:'Папка проекта',exact:true})).toHaveValue('C:\\new\\рабочая папка');
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('aplot-agent-workspace-v2-preview')!).data);expect(saved.tasks).toHaveLength(1);expect(saved.threads.t.entries[0].text).toBe('Keep this history');expect(saved.threads.t.cwd).toBe('C:\\new\\рабочая папка');
 const box=await dialog.boundingBox();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(width+1);
 await page.screenshot({path:`artifacts/project-paths-2026-10-23/project-settings-${width}.png`});
});
test('keeps invalid folder editable, then saves corrected path',async({page})=>{
 const dialog=await seed(page);const path=dialog.getByRole('textbox',{name:'Папка проекта',exact:true});await path.fill('C:\\missing\\another');await dialog.getByRole('button',{name:'Сохранить',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('выберите существующую папку');
 expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('aplot-agent-workspace-v2-preview')!).data.projects[0].path)).toBe('C:\\missing\\workspace');await path.fill('C:\\valid');await dialog.getByRole('button',{name:'Сохранить',exact:true}).click();await expect(dialog).toBeHidden();
});
test('shows save failure and lets the user retry without losing the new path',async({page})=>{
 const dialog=await seed(page);await dialog.getByRole('textbox',{name:'Папка проекта',exact:true}).fill('C:\\valid');
 await page.evaluate(()=>{const original=Storage.prototype.setItem;Object.assign(window,{failPathSave:true});Storage.prototype.setItem=function(key,value){if(key==='aplot-agent-workspace-v2-preview'&&(window as unknown as {failPathSave:boolean}).failPathSave)throw new DOMException('quota','QuotaExceededError');return original.call(this,key,value);};});
 await dialog.getByRole('button',{name:'Сохранить',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('Не удалось сохранить');await page.evaluate(()=>Object.assign(window,{failPathSave:false}));await dialog.getByRole('button',{name:'Сохранить',exact:true}).click();await expect(dialog).toBeHidden();expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('aplot-agent-workspace-v2-preview')!).data.projects[0].path)).toBe('C:\\valid');
});
