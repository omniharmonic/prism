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
test('comments follow the room the page has, not the window: a narrow column in a wide window keeps its text width',async({browser})=>{
 const context=await browser.newContext({viewport:{width:1440,height:900}});const page=await context.newPage();
 await connect(page,context,server,'owner');await page.goto('/e2e-fixtures/collab-route.html?target=plan');
 const text=page.locator('.tiptap').first();await expect(text).toContainText('Alpha');
 // Both side panels open in the workspace leave the page a column like this one.
 await page.addStyleTag({content:'#root{width:700px}'});
 await expect.poll(async()=>(await page.locator('.collab-page-layout').boundingBox())!.width).toBeLessThanOrEqual(700);
 const before=(await text.boundingBox())!.width;
 await page.locator('.document-formatting-bar[data-chrome="row"]').getByRole('button',{name:/^Comments/}).click();
 await expect(page.getByRole('button',{name:'Add comment',exact:true})).toBeVisible();
 expect((await text.boundingBox())!.width).toBe(before);
 await context.close();
});
test('the comments column stays in view while a long page scrolls',async({browser})=>{
 const context=await browser.newContext({viewport:{width:1440,height:700}});const page=await context.newPage();
 await connect(page,context,server,'owner');await page.goto('/e2e-fixtures/collab-route.html?target=plan');
 const text=page.locator('.tiptap').first();await expect(text).toContainText('Alpha');
 await page.locator('.document-formatting-bar[data-chrome="row"]').getByRole('button',{name:/^Comments/}).click();
 const add=page.getByRole('button',{name:'Add comment',exact:true});await expect(add).toBeVisible();
 // Make the page several screens long, then go to its end.
 await text.evaluate(el=>{const pad=document.createElement('div');pad.style.height='3000px';el.parentElement!.appendChild(pad);});
 await page.mouse.move(400,400);await page.mouse.wheel(0,2400);
 await expect.poll(()=>page.evaluate(()=>{let n:Element|null=document.querySelector('.collab-page-layout');let top=window.scrollY;while(n){top=Math.max(top,(n as HTMLElement).scrollTop);n=n.parentElement;}return top;})).toBeGreaterThan(1000);
 await expect(add).toBeInViewport();
 await context.close();
});
