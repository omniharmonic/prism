import { test, expect, type Locator, type Page } from "@playwright/test";
async function start(page: Page) {
 await page.setViewportSize({width:390,height:844});
 await page.emulateMedia({reducedMotion:"reduce"});
 await page.goto("/e2e-fixtures/workspace.html?navigation");
 await expect(page.locator(".tiptap")).toContainText("A shared place");
 await page.evaluate(() => (window as any).prismFixtureUI.setState({sidebarOpen:false,contextPanelOpen:false}));
}
async function drag(target: Locator, options: {x?:number; vertical?:boolean; cancel?:boolean; multi?:boolean} = {}) {
 await target.evaluate((element, o) => {
  const x = o.x ?? 3, endX = o.vertical ? x+8 : x+100, endY = o.vertical ? 230 : 103;
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
 await drag(page.locator(".document-writing-scroll"));
 await expect(page.locator(".tiptap")).toContainText("EDGE_DRAFT_RETAINS");
 await expect(drawer(page)).toHaveCount(0);
 expect(await page.locator(".edge-swipe-hint").evaluate(el => parseFloat(getComputedStyle(el).transitionDuration))).toBeLessThanOrEqual(0.001);
});
test("editor selection, controls, graphs and horizontal scrollers own their touch gestures", async ({page}) => {
 await start(page);
 await drag(page.locator(".tiptap")); await expect(drawer(page)).toHaveCount(0);
 await drag(page.locator(".tabbar-phone button").first()); await expect(drawer(page)).toHaveCount(0);
 await page.locator(".document-writing-scroll").evaluate(el => {
  const area = document.createElement("div"); area.id="edge-fixture"; area.style.cssText="width:100px;overflow-x:auto";
  area.innerHTML='<div style="width:500px">Sideways content</div>'; el.prepend(area);
 });
 await drag(page.locator("#edge-fixture div")); await expect(drawer(page)).toHaveCount(0);
 await page.locator("#edge-fixture").evaluate(el => {el.removeAttribute("style");el.setAttribute("data-no-edge-swipe","");});
 await drag(page.locator("#edge-fixture div")); await expect(drawer(page)).toHaveCount(0);
 await page.locator(".tiptap p").first().evaluate(el => { const range=document.createRange();range.selectNodeContents(el);getSelection()!.removeAllRanges();getSelection()!.addRange(range); });
 await drag(page.locator(".document-writing-scroll")); await expect(drawer(page)).toHaveCount(0);
});
test("middle, vertical, cancelled and multi-touch gestures never navigate", async ({page}) => {
 await start(page);
 const content=page.locator(".document-writing-scroll");
 for (const options of [{x:60},{vertical:true},{cancel:true},{multi:true}]) { await drag(content, options);await expect(drawer(page)).toHaveCount(0); }
 await drag(content);await expect(drawer(page)).toBeVisible();
});
