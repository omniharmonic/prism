import {test,expect} from '@playwright/test';

test('showing and hiding existing relationships cannot remove or persist them as authored arrows',async({page})=>{
 await page.goto('/e2e-fixtures/canvas.html');
 await expect(page.locator('.excalidraw')).toBeVisible();
 await page.getByRole('button',{name:'Show links',exact:true}).click();
 await expect(page.getByRole('button',{name:'Hide links',exact:true})).toBeVisible();
 await expect.poll(()=>page.evaluate(()=>(window as any).prismCanvasFixture.reads)).toBe(2);
 await expect.poll(()=>page.evaluate(()=>(window as any).prismCanvasFixture.writes.length)).toBeGreaterThan(0);
 await page.getByRole('button',{name:'Hide links',exact:true}).click();
 await expect(page.getByRole('button',{name:'Show links',exact:true})).toBeVisible();
 const result=await page.evaluate(()=>{const c=(window as any).prismCanvasFixture;return {links:c.linkWrites,scenes:c.writes.filter((w:any)=>w.content).map((w:any)=>JSON.parse(w.content).elements)};});
 expect(result.links).toEqual([]);
 expect(result.scenes.length).toBeGreaterThan(0);
 for(const scene of result.scenes){expect(scene.some((e:any)=>e.type==='arrow'||e.customData?.prismLinkViz)).toBe(false);expect(scene.filter((e:any)=>e.type==='rectangle')).toHaveLength(2);}
});

test('legacy preview arrows and their unmarked labels are excluded without dropping authored content',async({page})=>{
 await page.goto('/e2e-fixtures/canvas.html');
 const kept=await page.evaluate(()=>(window as any).prismCanvasFixture.authoredCanvasElements([
  {id:'card',type:'rectangle',boundElements:[{id:'preview',type:'arrow'},{id:'authored',type:'arrow'}]}, {id:'authored',type:'arrow'},
  {id:'preview',type:'arrow',customData:{prismLinkViz:true}}, {id:'preview-label',containerId:'preview'},
  {id:'author-label',containerId:'authored'},
 ]));
 expect(kept.map((e:any)=>e.id)).toEqual(['card','authored','author-label']);
 expect(kept[0].boundElements).toEqual([{id:'authored',type:'arrow'}]);
});
