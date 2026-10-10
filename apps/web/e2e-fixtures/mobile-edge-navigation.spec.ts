import { test, expect, type Locator, type Page } from "@playwright/test";
async function start(page: Page) {
 await page.setViewportSize({width:390,height:844});
 await page.emulateMedia({reducedMotion:"reduce"});
 await page.goto("/e2e-fixtures/workspace.html?navigation");
 await expect(page.locator(".tiptap")).toContainText("A shared place");
 await page.evaluate(() => (window as any).prismFixtureUI.setState({sidebarOpen:false,contextPanelOpen:false}));
}
async function drag(target: Locator, options: {x?:number; vertical?:boolean; cancel?:boolean; multi?:boolean; left?:boolean} = {}) {
 await target.evaluate((element, o) => {
  const x = o.x ?? 3, endX = o.vertical ? x+8 : o.left ? x-100 : x+100, endY = o.vertical ? 230 : 103;
  for (const type of ["touchstart","touchmove",o.cancel ? "touchcancel" : "touchend"]) {
   const t = {clientX:type === "touchstart" ? x : endX,clientY:type === "touchstart" ? 100 : endY};
   const event = new Event(type,{bubbles:true});
   Object.defineProperty(event,"touches",{value:type === "touchend" ? [] : o.multi && type === "touchmove" ? [t,{...t,clientX:40}] : [t]});
   Object.defineProperty(event,"changedTouches",{value:[t]});
   element.dispatchEvent(event);
  }
 }, options);
}
const drawer = (page:Page) => page.getByRole("dialog",{name:"Workspace navigation"});
test("header edge opens the sidebar even with history; content edge goes back without replacing drafts", async ({page}) => {
 await start(page);
 await page.locator(".tiptap").press("ControlOrMeta+End");
 await page.locator(".tiptap").pressSequentially(" EDGE_DRAFT_RETAINS");
 await page.evaluate(() => (window as any).prismFixtureUI.getState().openTab("field-notes","Field notes","document"));
 await expect(page.locator(".tiptap")).toContainText("Useful observations");
 await drag(page.locator(".tabbar-phone"));
 await expect(drawer(page)).toBeVisible();
 await page.keyboard.press("Escape");
 await expect(page.locator(".tiptap")).toContainText("Useful observations");
 await drag(page.locator(".document-writing-scroll"), {x:18});
 await expect(page.locator(".tiptap")).toContainText("EDGE_DRAFT_RETAINS");
 await expect(drawer(page)).toHaveCount(0);
 expect(await page.locator(".edge-swipe-hint").evaluate(el => parseFloat(getComputedStyle(el).transitionDuration))).toBeLessThanOrEqual(0.001);
});
test("editor selection, controls, graphs and horizontal scrollers own their touch gestures", async ({page}) => {
 await start(page);
 await drag(page.locator(".tiptap"), {x:18}); await expect(drawer(page)).toHaveCount(0);
 await drag(page.locator(".tabbar-phone button").first(), {x:18}); await expect(drawer(page)).toHaveCount(0);
 await page.locator(".document-writing-scroll").evaluate(el => {
  const area = document.createElement("div"); area.id="edge-fixture"; area.style.cssText="width:100px;overflow-x:auto";
  area.innerHTML='<div style="width:500px">Sideways content</div>'; el.prepend(area);
 });
 await drag(page.locator("#edge-fixture div"), {x:18}); await expect(drawer(page)).toHaveCount(0);
 await page.locator("#edge-fixture").evaluate(el => {el.removeAttribute("style");el.setAttribute("data-no-edge-swipe","");});
 await drag(page.locator("#edge-fixture div"), {x:18}); await expect(drawer(page)).toHaveCount(0);
 await page.locator(".tiptap p").first().evaluate(el => { const range=document.createRange();range.selectNodeContents(el);getSelection()!.removeAllRanges();getSelection()!.addRange(range); });
 await drag(page.locator(".document-writing-scroll")); await expect(drawer(page)).toHaveCount(0);
});
test("middle, vertical, cancelled and multi-touch gestures never navigate", async ({page}) => {
 await start(page);
 const content=page.locator(".document-writing-scroll");
 for (const options of [{x:60},{vertical:true},{cancel:true},{multi:true}]) { await drag(content, options);await expect(drawer(page)).toHaveCount(0); }
 await drag(content);await expect(drawer(page)).toBeVisible();
});

test("outer navigation edge has priority across renderer surfaces without taking ordinary taps", async ({page}) => {
 await start(page);
 await page.evaluate(() => (window as any).prismFixtureUI.getState().openTab("field-notes","Field notes","document"));
 await page.locator(".document-writing-scroll").evaluate(el => {
  const region = document.createElement("div"); region.id="navigation-edge-surface"; region.setAttribute("data-no-edge-swipe","");
  region.innerHTML='<svg width="100" height="100"><rect width="100" height="100"/></svg>'; el.prepend(region);
 });
 await drag(page.locator("#navigation-edge-surface svg"), {x:18}); await expect(drawer(page)).toHaveCount(0);
 await drag(page.locator("#navigation-edge-surface svg"), {x:3}); await expect(drawer(page)).toBeVisible();
 await page.getByRole("button", {name:"Close navigation"}).click(); await expect(drawer(page)).toHaveCount(0);
 await expect(page.locator(".tiptap")).toContainText("Useful observations");
 await drag(page.locator(".tabbar-phone"), {x:28}); await expect(drawer(page)).toBeVisible();
});
test("navigation drawer swipes closed while vertical scroll, forms and cancelled gestures remain untouched", async ({page}) => {
 await start(page); await drag(page.locator(".tabbar-phone"));
 const header=drawer(page).locator(".workspace-context-header");
 for (const options of [{x:180,left:true,vertical:true},{x:180,left:true,cancel:true},{x:180,left:true,multi:true}]) {
  await drag(header, options); await expect(drawer(page)).toBeVisible();
 }
 const input = drawer(page).locator("input").first();
 if (await input.count()) { await input.fill("Field"); await drag(input,{x:180,left:true}); await expect(drawer(page)).toBeVisible(); }
 await drag(header,{x:180,left:true}); await expect(drawer(page)).toHaveCount(0);
 await expect(page.locator(".tiptap")).toContainText("A shared place");
});

test("real touch navigation consumes the horizontal edge drag but retains an ordinary edge tap", async ({page}) => {
 await start(page);
 await page.locator(".document-writing-scroll").evaluate(el => {
  const button=document.createElement("button"); button.id="real-edge-control"; button.textContent="Edge control";
  button.style.cssText="position:fixed;left:0;top:130px;width:150px;height:44px;z-index:20";
  (window as any).edgeActions={pointers:0,clicks:0};
  button.addEventListener("pointerdown",()=>{(window as any).edgeActions.pointers++;});
  button.addEventListener("click",()=>{(window as any).edgeActions.clicks++;}); el.append(button);
 });
 const cdp=await page.context().newCDPSession(page);
 const touch=async(type:string,x?:number,y=150)=>cdp.send("Input.dispatchTouchEvent",{type,touchPoints:x===undefined?[]:[{x,y}]});
 await touch("touchStart",3); await touch("touchMove",35); await touch("touchMove",105); await touch("touchEnd");
 await expect(drawer(page)).toBeVisible();
 expect(await page.evaluate(()=>(window as any).edgeActions)).toEqual({pointers:0,clicks:0});
 await page.getByRole("button",{name:"Close navigation"}).click();
 await touch("touchStart",3); await touch("touchEnd");
 await expect.poll(()=>page.evaluate(()=>(window as any).edgeActions.clicks)).toBe(1);
 await expect(drawer(page)).toHaveCount(0);
 await cdp.detach();
});
