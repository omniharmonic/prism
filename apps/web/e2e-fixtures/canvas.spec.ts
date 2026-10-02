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

for (const mode of ['', '?collab']) {
 test(`canvas picker retains failed selections and never copies denied previews ${mode}`,async({page})=>{
  await page.goto('/e2e-fixtures/canvas.html'+mode);
  await expect(page.locator('.excalidraw')).toBeVisible();
  await page.getByRole('checkbox',{name:'Copy preview'}).check();
  await page.getByRole('button',{name:'Notes',exact:true}).click();
  await page.getByRole('checkbox',{name:'Select Card C',exact:true}).check();
  await page.evaluate(()=>{(window as any).prismCanvasFixture.deny=true;});
  await page.getByRole('button',{name:'Add 1 selected',exact:true}).click();
  await expect(page.getByText('The note could not be added.',{exact:false})).toBeVisible();
  await expect(page.getByRole('checkbox',{name:'Select Card C',exact:true})).toBeChecked();
  const count=()=>page.evaluate(()=>{const c=(window as any).prismCanvasFixture;const scene=location.search.includes('collab')?[...c.doc.getMap('elements').values()]:c.writes.filter((w:any)=>w.content).map((w:any)=>JSON.parse(w.content).elements).at(-1)??[];return scene.filter((e:any)=>e.type==='rectangle'&&e.customData?.prismNoteId==='Card C').length;});
  expect(await count()).toBe(0);
  await page.evaluate(()=>{(window as any).prismCanvasFixture.deny=false;});
  await page.getByRole('button',{name:'Add 1 selected',exact:true}).click();
  await expect.poll(count).toBe(1);
  await expect(page.getByRole('checkbox',{name:'Select Card C',exact:true})).not.toBeChecked();
 });
 test(`canvas phone picker closes with Escape and ignores late reads after audience change ${mode}`,async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto('/e2e-fixtures/canvas.html'+mode);
  await page.getByRole('button',{name:'Notes',exact:true}).click();
  await page.getByRole('textbox',{name:'Find canvas notes'}).fill('Card C');
  await expect(page.getByRole('button',{name:'Card C Test/Card C',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.evaluate(()=>{(window as any).prismCanvasFixture.hold=true;});
  await page.getByRole('button',{name:'Card C Test/Card C',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>!!(window as any).prismCanvasFixture.release)).toBe(true);
  await page.evaluate(()=>{const c=(window as any).prismCanvasFixture;c.scope='other-owner';c.release();});
  await page.getByRole('textbox',{name:'Find canvas notes'}).press('Escape');
  await expect(page.getByRole('complementary',{name:'Canvas notes'})).not.toBeVisible();
  await expect(page.getByRole('button',{name:'Notes',exact:true})).toBeFocused();
  const copied=await page.evaluate(()=>{const c=(window as any).prismCanvasFixture;return JSON.stringify(c.writes).includes('Card C')||JSON.stringify([...c.doc.getMap('elements').values()]).includes('Card C');});
  expect(copied).toBe(false);
  await page.getByRole('button',{name:'Notes',exact:true}).click();
  await page.screenshot({path: `test-results/canvas-picker-mobile${mode ? '-collab' : ''}.png`});
 });
}

for (const mode of ['', 'collab']) {
 test(`focused canvas preserves the mounted scene and authored cards on a phone ${mode}`,async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto('/e2e-fixtures/canvas.html?'+mode);
  await expect(page.locator('.excalidraw')).toBeVisible();
  await page.evaluate(()=>{(window as any).mountedCanvas=document.querySelector('.excalidraw');});
  await page.getByRole('button',{name:'Focus canvas',exact:true}).click();
  const focused=page.getByRole('dialog',{name:'Focused canvas'});
  const rect=await focused.boundingBox();
  expect(rect?.width).toBe(390);expect(rect?.height).toBe(844);expect(rect?.x).toBe(0);expect(rect?.y).toBe(0);
  await focused.getByRole('button',{name:'Notes',exact:true}).click();
  await page.getByRole('button',{name:'Card C Test/Card C',exact:true}).click();
  await expect(page.getByRole('button',{name:'Card C On canvas',exact:true})).toBeVisible();
  await page.getByRole('textbox',{name:'Find canvas notes'}).press('Escape');
  await expect(focused).toBeVisible();
  await focused.getByRole('button',{name:'Browse cards'}).click();
  const cards=page.getByRole('complementary',{name:'Notes on canvas'});
  await cards.getByRole('textbox',{name:'Find a card'}).fill('Card C');
  await expect(cards.getByRole('button',{name:'Open Card C',exact:true})).toBeVisible();
  await cards.getByRole('button',{name:'Find Card C on canvas'}).click();
  await expect(cards).not.toBeVisible();
  await focused.getByRole('button',{name:'Back to document',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).mountedCanvas===document.querySelector('.excalidraw'))).toBe(true);
  await expect(page.getByRole('button',{name:'Focus canvas',exact:true})).toBeFocused();
  await page.getByRole('button',{name:'Browse cards'}).click();
  await expect(page.getByRole('button',{name:'Open Card C',exact:true})).toBeVisible();
  await page.getByRole('textbox',{name:'Find a card'}).press('Escape');
  await page.getByRole('button',{name:'Focus canvas',exact:true}).click();
  await focused.getByRole('button',{name:'Back to document',exact:true}).press('Escape');
  await expect(focused).not.toBeVisible();
 });
 test(`read-only canvas navigation verifies source access without changing its scene ${mode}`,async({page})=>{
  await page.goto('/e2e-fixtures/canvas.html?readonly&'+mode);
  await expect(page.locator('.excalidraw')).toBeVisible();
  await expect(page.getByRole('button',{name:'Notes',exact:true})).not.toBeVisible();
  await page.getByRole('button',{name:'Browse cards'}).click();
  await expect(page.getByRole('button',{name:'Open Card A',exact:true})).toBeVisible();
  await page.evaluate(()=>{(window as any).prismCanvasFixture.deny=true;});
  await page.getByRole('button',{name:'Open Card A',exact:true}).click();
  await expect(page.getByRole('complementary',{name:'Notes on canvas'})).toContainText('This note is unavailable');
  expect(await page.evaluate(()=>(window as any).prismCanvasFixture.ui.getState().openTabs.length)).toBe(0);
  await page.evaluate(()=>{(window as any).prismCanvasFixture.deny=false;});
  await page.getByRole('button',{name:'Open Card A',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).prismCanvasFixture.ui.getState().openTabs.some((t:any)=>t.noteId==='Card A'))).toBe(true);
  const result=await page.evaluate(()=>{const c=(window as any).prismCanvasFixture;return {writes:c.writes,links:c.linkWrites,elements:[...c.doc.getMap('elements').keys()].length};});
  expect(result.writes).toEqual([]);expect(result.links).toEqual([]);expect(result.elements).toBe(4);
 });
}

for(const mode of ["","&collab"]){
 test(`authored relationships wait for acknowledgement and retry visibly without generic link deletion ${mode}`,async({page})=>{
  await page.goto("/e2e-fixtures/canvas.html?relations"+mode);
  await expect(page.getByRole("button",{name:"Retry relationships"})).toBeVisible();
  await expect(page.getByText("Relationships saved",{exact:true})).not.toBeVisible();
  await page.evaluate(()=>{(window as any).prismCanvasFixture.rejectRelations=false;});
  await page.getByRole("button",{name:"Retry relationships"}).click();
  await expect(page.getByText("Relationships saved",{exact:true})).toBeVisible();
  const attempts=await page.evaluate(()=>(window as any).prismCanvasFixture.syncAttempts.map((x:string)=>JSON.parse(x)));
  expect(attempts).toHaveLength(2);
  for(const attempt of attempts)expect(attempt).toEqual([{arrowId:"authored-arrow",sourceId:"Card A",targetId:"Card B",relationship:"related"}]);
  expect(await page.evaluate(()=>(window as any).prismCanvasFixture.linkWrites)).toEqual([]);
  await page.getByRole("button",{name:"Show links",exact:true}).click();
  await page.getByRole("button",{name:"Hide links",exact:true}).click();
  expect(await page.evaluate(()=>(window as any).prismCanvasFixture.linkWrites)).toEqual([]);
 });
}

for(const mode of ["","&collab"]){
 test(`a connection can become decorative without deleting its drawing ${mode}`,async({page})=>{
  await page.goto("/e2e-fixtures/canvas.html?relations"+mode);
  await page.evaluate(()=>{(window as any).prismCanvasFixture.rejectRelations=false;});
  await expect(page.getByText("Relationships saved",{exact:true})).toBeVisible();
  await page.locator("canvas.interactive").click({position:{x:30,y:250}});
  await page.keyboard.press("Meta+a");
  await page.getByRole("checkbox",{name:"Link this arrow to notes"}).uncheck();
  await expect(page.getByRole("checkbox",{name:"Decorative arrow"})).not.toBeChecked();
  await expect.poll(()=>page.evaluate(()=>(window as any).prismCanvasFixture.syncAttempts.at(-1))).toBe("[]");
  if(!mode)await expect.poll(()=>page.evaluate(()=>(window as any).prismCanvasFixture.writes.some((w:any)=>w.content&&JSON.parse(w.content).elements.some((e:any)=>e.id==="authored-arrow"&&e.customData?.prismRelationship===false)))).toBe(true);
  const result=await page.evaluate(()=>{const c=(window as any).prismCanvasFixture;const elements=location.search.includes("collab")?[...c.doc.getMap("elements").values()]:JSON.parse(c.writes.filter((w:any)=>w.content).at(-1).content).elements;return {arrow:elements.find((e:any)=>e.id==="authored-arrow"),links:c.linkWrites};});
  expect(result.arrow.isDeleted).toBeFalsy();expect(result.arrow.customData.prismRelationship).toBe(false);expect(result.links).toEqual([]);
  await page.getByRole("checkbox",{name:"Decorative arrow"}).check();
  await expect(page.getByText("Relationships saved",{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>JSON.parse((window as any).prismCanvasFixture.syncAttempts.at(-1)).length)).toBe(1);
 });
}
