import {test,expect} from '@playwright/test';
import {connect,startRealServer,type RealServer} from './real-server';
let server:RealServer;
test.beforeAll(async({},info)=>{server=await startRealServer(String(info.project.use.baseURL));});
test.afterAll(async()=>server?.stop());
for(const width of [390,1024,1440]){
 test(`document chrome unified at ${width}`,async({browser},info)=>{
  const context=await browser.newContext({viewport:{width,height:900},hasTouch:width<1440,isMobile:width===390});const page=await context.newPage();
  await connect(page,context,server,'owner');await page.goto('/e2e-fixtures/collab-route.html?target=plan');
  await expect(page.locator('.tiptap').first()).toContainText('Alpha');
  const row=page.locator('.document-formatting-bar[data-chrome="row"]');await expect(row).toBeVisible();
  await expect(row.getByRole('button',{name:/^Comments/})).toHaveCount(1);
  await expect(page.getByRole('button',{name:'Add comment',exact:true})).toHaveCount(0);
  await page.screenshot({path:info.outputPath(`chrome-closed-${width}.png`)});
  await row.getByRole('button',{name:/^Comments/}).click();
  await expect(page.getByRole('button',{name:'Add comment',exact:true})).toBeVisible();
  await page.screenshot({path:info.outputPath(`chrome-${width}.png`)});await context.close();
 });
 test(`folder cancellation stays inside sidebar at ${width}`,async({browser},info)=>{
  const context=await browser.newContext({viewport:{width,height:900},hasTouch:true,isMobile:width===390});const page=await context.newPage();
  await page.goto('/e2e-fixtures/workspace.html?navigation');
  const panel=page.getByRole('dialog',{name:'Document panel'});if(await panel.isVisible())await panel.getByRole('button',{name:/Close/}).first().click();
  if(width===390)await page.getByRole('button',{name:'Notes',exact:true}).click();
  const nav=page.locator('.workspace-navigation');await nav.getByRole('button',{name:'New folder',exact:true}).click();
  const input=nav.getByRole('textbox',{name:'Folder name'});await input.fill('A very long folder name for layout');
  const outer=(await nav.boundingBox())!;
  for(const item of [input,nav.getByRole('button',{name:'Add',exact:true}),nav.getByRole('button',{name:'Cancel folder'})]){const box=(await item.boundingBox())!;expect(box.x).toBeGreaterThanOrEqual(outer.x);expect(box.x+box.width).toBeLessThanOrEqual(outer.x+outer.width);}
  await page.screenshot({path:info.outputPath(`folder-${width}.png`)});
  await nav.getByRole('button',{name:'Cancel folder'}).click();await expect(input).toHaveCount(0);await context.close();
 });
}
