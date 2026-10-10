import {test,expect} from "@playwright/test";

for (const coarse of [false,true]) test.describe(coarse ? "wide touch" : "wide mouse", () => {
 test.use({hasTouch:coarse,viewport:{width:1024,height:768}});
 test("compiled coarse utilities and settings controls retain their intended size",async({page},info)=>{
  await page.goto("/e2e-fixtures/workspace.html");
  expect(await page.evaluate(()=>matchMedia("(hover: none) and (pointer: coarse)").matches)).toBe(coarse);
  await page.evaluate(()=>{
   const area=document.createElement("div");area.id="coarse-utilities";
   area.innerHTML='<div class="min-h-control" data-size="height"></div><div class="min-w-control" data-size="width"></div><div class="size-control" data-size="square"></div><div class="coarse:h-11" data-size="variant"></div>';
   document.body.append(area);
  });
  const size=coarse?44:32;
  await expect(page.locator('[data-size="height"]')).toHaveCSS("min-height",`${size}px`);
  await expect(page.locator('[data-size="width"]')).toHaveCSS("min-width",`${size}px`);
  await expect(page.locator('[data-size="square"]')).toHaveCSS("width",`${size}px`);
  await expect(page.locator('[data-size="square"]')).toHaveCSS("height",`${size}px`);
  if(coarse) await expect(page.locator('[data-size="variant"]')).toHaveCSS("height","44px");
  await page.evaluate(()=>(window as any).prismFixtureUI.getState().setSettingsOpen(true));
  const dialog=page.getByRole("dialog",{name:"Settings",exact:true});
  await expect(dialog).toBeVisible();
  if(coarse){
   for (const button of await dialog.locator(".prism-settings button").all()) {
    const bounds=await button.boundingBox();expect(bounds!.height).toBeGreaterThanOrEqual(44);expect(bounds!.width).toBeGreaterThanOrEqual(44);
   }
   for(const select of await dialog.locator("select").all())expect((await select.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }else{
   expect((await dialog.getByLabel("Editor Font",{exact:true}).boundingBox())!.height).toBeLessThan(44);
  }
  expect(await dialog.locator(".prism-settings__content").evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
  await page.screenshot({path:info.outputPath(`settings-ipad-${coarse?"touch":"mouse"}.png`),animations:"disabled"});
 });
});
