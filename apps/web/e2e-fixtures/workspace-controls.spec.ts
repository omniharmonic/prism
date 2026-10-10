import { mkdirSync } from "node:fs";
import { test, expect } from "@playwright/test";
const shots = "/private/tmp/prism-web-controls-shots";
mkdirSync(shots, { recursive: true });
for (const [device,width,height] of [["phone",390,844],["ipad",1024,768],["desktop",1440,900]] as const) {
 test(`${device}: personal property visibility persists and is scoped`, async ({page}) => {
  await page.setViewportSize({width,height}); await page.emulateMedia({reducedMotion:"reduce"});
  await page.goto("/e2e-fixtures/databases.html?open=page");
  const bar=page.getByRole("group",{name:"Page properties"});
  await bar.getByRole("button",{name:"Display properties",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"Display properties"});
  for(const box of await dialog.getByRole("checkbox").all()) await box.uncheck();
  await dialog.getByRole("checkbox",{name:"Status",exact:true}).check(); await page.keyboard.press("Escape");
  await expect(bar.getByRole("button",{name:"Status: In progress"})).toBeVisible();
  await expect(bar.getByRole("button",{name:"Priority: Medium"})).toHaveCount(0);
  await page.reload(); await expect(bar.getByRole("button",{name:"Status: In progress"})).toBeVisible(); await expect(page.locator(".tiptap")).toContainText("A single, evolving place"); await expect(bar.getByRole("button",{name:"Priority: Medium"})).toHaveCount(0);
  expect(await bar.locator(".db-more-chevron").evaluate(el => parseFloat(getComputedStyle(el).transitionDuration))).toBeLessThanOrEqual(0.001);
  await page.screenshot({path:`${shots}/properties-${device}.png`});
  await bar.getByRole("button",{name:/more properties/}).click();
  await expect(bar.getByRole("button",{name:"Priority: Medium"})).toBeVisible();
  await bar.locator(".db-prop-more button").click();
  await bar.getByRole("button",{name:"Display properties",exact:true}).click();
  await dialog.getByRole("checkbox",{name:"Status",exact:true}).uncheck(); await page.keyboard.press("Escape");
  await page.reload(); await expect(bar.getByRole("button",{name:"Status: In progress"})).toHaveCount(0);
  expect(await page.evaluate(()=>({writes:(window as any).dbFixture.writes,schemas:(window as any).dbFixture.schemaWrites}))).toEqual({writes:[],schemas:[]});
  await page.goto("/e2e-fixtures/databases.html?open=page&audience=other-user-vault");
  await expect(bar.getByRole("button",{name:"Status: In progress"})).toBeVisible();
  await expect(bar.getByRole("button",{name:"Priority: Medium"})).toBeVisible();
 });
}
test("Trash drop confirms, cancels, moves and undoes; external text is ignored",async({page})=>{
 await page.goto("/e2e-fixtures/pages-nav.html"); const nav=page.locator(".workspace-navigation").first();
 const row=nav.getByRole("button",{name:"Plan",exact:true});const trash=nav.getByRole("button",{name:"Trash",exact:true});
 const footer = nav.locator(".workspace-nav-footer");
 expect(await footer.evaluate(el => { const p = getComputedStyle(el, "::before"); return { top:p.top,height:p.height,pointer:p.pointerEvents }; })).toEqual({top:"-20px",height:"20px",pointer:"none"});
 await row.dragTo(trash);await expect(page.getByRole("alertdialog")).toContainText("Move “Plan” to Trash?");
 expect(await page.evaluate(()=>(window as any).prismFixtureWrites.filter((w: any) => !w.preferences))).toEqual([]);
 await page.getByRole("button",{name:"Cancel",exact:true}).click();await expect(row).toBeVisible();
 await row.dragTo(trash);await page.getByRole("button",{name:"Move to Trash",exact:true}).click();await expect(row).toHaveCount(0);
 await page.screenshot({path:`${shots}/trash-desktop.png`});await page.getByRole("button",{name:"Undo",exact:true}).click();await expect(row).toBeVisible();
 const external=await page.evaluateHandle(()=>{const d=new DataTransfer();d.setData("text/plain","Plan");return d;});
 await trash.dispatchEvent("drop",{dataTransfer:external});await expect(page.getByRole("alertdialog")).toHaveCount(0);
});
for(const width of [320,390,1024,1440])test(`graph close stays within ${width}px viewport`,async({page})=>{
 await page.setViewportSize({width,height:844});await page.goto("/e2e-fixtures/graph.html");await page.getByRole("button",{name:"Expand graph"}).click();
 const close=page.getByRole("button",{name:"Close graph"});const box=await close.boundingBox();expect(box).not.toBeNull();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(width);expect(box!.width).toBeGreaterThanOrEqual(44);
 await page.screenshot({path:`${shots}/graph-${width}.png`});await close.click();await expect(page.getByRole("dialog")).toHaveCount(0);
});

for (const mode of ["owner", "member"] as const) test(`email detail status edits one guarded tag operation (${mode})`, async ({ page }) => {
 await page.goto(`/e2e-fixtures/inbox.html?resolved&email-status=${mode}`);
 await page.locator(".prism-message-row").filter({hasText:"Saturday workshop agenda"}).click();
 const status=page.getByRole("combobox",{name:"Thread status"});await expect(status).toHaveValue("action-required");
 await status.selectOption("urgent");await expect(status).toHaveValue("urgent");
 expect(await page.evaluate(()=>(window as any).prismInboxFixture.tagWrites)).toEqual([{id:"mail-agenda",op:"change",add:["urgent"],remove:["action-required"],member:mode==="member"}]);
 await page.evaluate(()=>(window as any).prismInboxFixture.failTagWrites=true);await status.selectOption("informational");
 await expect(status).toHaveValue("urgent");await expect(page.locator(".prism-email-category").getByRole("status")).toContainText("not confirmed");
 expect(await page.evaluate(()=>(window as any).prismInboxFixture.sends)).toEqual([]);
});
test("view-only email status stays readable and cannot edit",async({page})=>{
 await page.goto("/e2e-fixtures/inbox.html?resolved&email-status=view");await page.locator(".prism-message-row").filter({hasText:"Saturday workshop agenda"}).click();
 await expect(page.getByRole("combobox",{name:"Thread status"})).toBeDisabled();expect(await page.evaluate(()=>(window as any).prismInboxFixture.tagWrites)).toEqual([]);
});
