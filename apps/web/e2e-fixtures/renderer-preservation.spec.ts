import { test, expect } from "@playwright/test";
for (const kind of ["website", "presentation", "dashboard"]) {
 test(`${kind} respects readonly without offering mutations`,async({page})=>{
  await page.goto(`/e2e-fixtures/renderer-preservation.html?kind=${kind}&readonly`);
  if(kind==="website") await expect(page.locator("textarea")).toHaveAttribute("readonly","");
  if(kind==="presentation") {await expect(page.getByText("2 slides",{exact:true})).toBeVisible();await expect(page.getByRole("button",{name:"Add Slide",exact:true})).toHaveCount(0);await page.getByRole("button",{name:"Slide detail",exact:true}).click();await expect(page.getByLabel("Slide markdown")).toHaveAttribute("readonly","");}
  if(kind==="dashboard") {await expect(page.getByText("Project overview",{exact:true})).toBeVisible();await expect(page.getByRole("button",{name:"Edit Dashboard"})).toHaveCount(0);await expect(page.getByRole("button",{name:"Create task"})).toBeDisabled();}
  expect(await page.evaluate(()=>(window as any).prismRendererFixture.writes)).toEqual([]);
 });
}
test("project related notes use a path boundary and open actual records",async({page})=>{
 await page.goto("/e2e-fixtures/renderer-preservation.html?kind=project");
 await expect(page.getByRole("button",{name:"Brief",exact:true})).toBeVisible();
 await expect(page.getByRole("button",{name:"Unrelated",exact:true})).toHaveCount(0);
 await page.getByRole("button",{name:"Review todo"}).click();
 expect(await page.evaluate(()=>(window as any).prismRendererFixture.open().at(-1).noteId)).toBe("task-a");
});
test("map reports unavailable reads instead of claiming there are no locations",async({page})=>{
 await page.goto("/e2e-fixtures/renderer-preservation.html?kind=map&fail");
 await expect(page.getByRole("alert")).toContainText("Locations could not be loaded");
 await expect(page.getByText("Nothing on the map yet")).toHaveCount(0);
});

test("presentation navigation and source editing save through the injected client and reload",async({page})=>{
 await page.goto("/e2e-fixtures/renderer-preservation.html?kind=presentation");
 await page.getByRole("button",{name:"Slide detail",exact:true}).click();
 await expect(page.getByRole("button",{name:"Previous slide"})).toBeDisabled();
 await page.getByRole("button",{name:"Next slide"}).click();
 await page.getByLabel("Slide markdown").fill("# Edited next steps\n\n- Keep the source");
 await expect.poll(()=>page.evaluate(()=>(window as any).prismRendererFixture.notes().find((n:any)=>n.id==="presentation").content)).toContain("Edited next steps");
 await page.reload();await expect(page.getByText("Edited next steps",{exact:true})).toBeVisible();
 await page.getByRole("button",{name:"Add Slide",exact:true}).click();
 await expect(page.getByText("Slide 3 of 3",{exact:true})).toBeVisible();
 await page.getByRole("button",{name:"Slide grid",exact:true}).click();
 await page.getByRole("button",{name:"Delete slide 3",exact:true}).click({force:true});
 await expect(page.getByText("2 slides",{exact:true})).toBeVisible();
});
for(const kind of ["website","presentation"])test(`${kind} exposes save failure, retains source and retries explicitly`,async({page})=>{
 await page.goto(`/e2e-fixtures/renderer-preservation.html?kind=${kind}&fail`);
 if(kind==="presentation")await page.getByRole("button",{name:"Slide detail",exact:true}).click();
 const input=page.getByLabel(kind==="website"?"Website source":"Slide markdown");
 await input.fill("# Keep this unsaved source");
 await expect(page.getByRole("alert")).toContainText("Changes could not be saved");
 await expect(input).toHaveValue("# Keep this unsaved source");
 await page.evaluate(()=>(window as any).prismRendererFixture.fail=false);
 await page.getByRole("button",{name:"Retry save"}).click();
 await expect(page.getByRole("alert")).toHaveCount(0);
 await expect.poll(()=>page.evaluate((id)=>(window as any).prismRendererFixture.notes().find((n:any)=>n.id===id).content,kind)).toContain("Keep this unsaved source");
});
test("website preview stays opaque, source editing survives view changes and reload",async({page})=>{
 await page.goto("/e2e-fixtures/renderer-preservation.html?kind=website");
 await expect(page.frameLocator('iframe[title="Preview"]').getByRole("heading",{name:"Safe preview"})).toBeVisible();
 await expect(page.locator("iframe")).toHaveAttribute("sandbox","allow-scripts");
 expect(await page.locator("body").getAttribute("data-escaped")).toBeNull();
 await page.getByRole("button",{name:"Source view"}).click();
 await page.getByLabel("Website source").fill("<h1>Edited private source</h1>");
 await page.getByRole("button",{name:"Preview view"}).click();
 await expect(page.frameLocator("iframe").getByRole("heading",{name:"Edited private source"})).toBeVisible();
 await expect.poll(()=>page.evaluate(()=>(window as any).prismRendererFixture.notes().find((n:any)=>n.id==="website").content)).toBe("<h1>Edited private source</h1>");
 await page.reload();await expect(page.getByLabel("Website source")).toHaveValue("<h1>Edited private source</h1>");
});
test("dashboard widgets retain actual filtered source grouping and configuration on reload",async({page})=>{
 const unexpected:string[]=[];
 page.on("request",request=>{if(/\/api\/(tree|paths)/.test(request.url()))unexpected.push(request.url());});
 await page.goto("/e2e-fixtures/renderer-preservation.html?kind=dashboard");
 await expect(page.getByText("Launch tasks",{exact:true})).toBeVisible();
 await expect(page.getByRole("button",{name:"Review",exact:true})).toBeVisible();
 await expect(page.getByRole("button",{name:"Release",exact:true})).toBeVisible();
 await page.getByRole("button",{name:"Edit Dashboard"}).click();
 await page.getByRole("button",{name:"Edit widget",exact:true}).first().click();
 await expect.poll(()=>page.evaluate(()=>(window as any).prismRendererFixture.treeReads)).toBeGreaterThan(0);
 await page.getByPlaceholder("Type to search paths...").fill("Projects/Prism/Research");
 await expect(page.getByRole("button",{name:"Projects/Prism/Research",exact:true})).toBeVisible();
 await page.getByPlaceholder("Type to search paths...").fill("");
 await page.getByPlaceholder("My Widget").fill("Launch checklist");
 expect(unexpected).toEqual([]);
 await page.getByRole("button",{name:"Save",exact:true}).click();
 await expect(page.getByText("Launch checklist",{exact:true})).toBeVisible();
 const saved=await page.evaluate(()=>(window as any).prismRendererFixture.notes().find((n:any)=>n.id==="dashboard"));
 expect(saved.metadata.unrelated).toBe("preserve");expect(saved.metadata.layout.widgets[0].source.tags).toEqual(["task"]);
 await page.reload();await expect(page.getByText("Launch checklist",{exact:true})).toBeVisible();
 await page.getByRole("button",{name:"Review",exact:true}).click();
 expect(await page.evaluate(()=>(window as any).prismRendererFixture.open().at(-1).noteId)).toBe("task-a");
});
for(const width of [1440,390])test(`map fallback preserves source list filters and navigation at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:900});
 await page.addInitScript(()=>{const get=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(this:HTMLCanvasElement,type:any,...args:any[]){if(String(type).includes("webgl"))return null;return get.apply(this,[type,...args] as any);} as any;});
 await page.goto("/e2e-fixtures/renderer-preservation.html?kind=map");
 await expect(page.getByTestId("map-list").getByRole("button",{name:"Fictional Creek"})).toBeVisible();
 await expect(page.getByTestId("vault-map")).toHaveAttribute("data-map-fallback","true");
 await page.getByRole("button",{name:"place",exact:true}).click();
 await expect(page.getByTestId("map-list").getByRole("button",{name:"Fictional Creek"})).toHaveCount(0);
 await page.getByRole("button",{name:"place",exact:true}).click();
 await page.getByTestId("map-list").getByRole("button",{name:"Fictional Creek"}).click();
 expect(await page.evaluate(()=>(window as any).prismRendererFixture.open().at(-1).noteId)).toBe("place");
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test("bioregion read-only properties and body links use actual notes without writes",async({page})=>{
 await page.goto("/e2e-fixtures/renderer-preservation.html?kind=bioregion-entity&readonly");
 await expect(page.getByText("Festuca rubra",{exact:true})).toBeVisible();
 await expect(page.getByTestId("bioregion-edit")).toHaveCount(0);
 await page.getByTestId("bioregion-body").getByText("the brief",{exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).prismRendererFixture.open().at(-1)?.noteId)).toBe("brief");
 expect(await page.evaluate(()=>(window as any).prismRendererFixture.writes)).toEqual([]);
});
for(const kind of ["unknown","dashboard","presentation"])test(`${kind} is usable at phone width without rewriting source`,async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.goto(`/e2e-fixtures/renderer-preservation.html?kind=${kind}&readonly`);
 if(kind==="unknown") {await expect(page.locator("pre")).toContainText("RAW_END");expect(await page.locator("pre").textContent()).toBe(await page.evaluate(()=>(window as any).prismRendererFixture.notes().find((n:any)=>n.id==="unknown").content));}
 if(kind==="dashboard")await expect(page.getByText("Launch tasks",{exact:true})).toBeVisible();
 if(kind==="presentation"){await page.getByRole("button",{name:"Slide detail",exact:true}).click();await expect(page.getByLabel("Slide markdown")).toBeVisible();}
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 expect(await page.evaluate(()=>(window as any).prismRendererFixture.writes)).toEqual([]);
 await page.screenshot({path:test.info().outputPath(`${kind}-390.png`)});
});
test("plain code source and literal sheet formulas remain readable and readonly",async({page})=>{
 await page.goto("/e2e-fixtures/renderer-preservation.html?kind=code&readonly");
 await expect(page.locator('.cm-content[contenteditable=false]')).toContainText("const answer = 42;");
 expect(await page.evaluate(()=>(window as any).prismRendererFixture.writes)).toEqual([]);
 await page.goto("/e2e-fixtures/renderer-preservation.html?kind=spreadsheet&readonly");
 await expect(page.locator('input[value="=B2+1"]')).toHaveAttribute("readonly","");
 // These engines store literal cell text; this is preservation, not formula evaluation.
 expect(await page.evaluate(()=>(window as any).prismRendererFixture.writes)).toEqual([]);
});
test("unavailable injected location hints keep the typed widget path and retry separately",async({page})=>{
 await page.goto("/e2e-fixtures/renderer-preservation.html?kind=dashboard");
 await page.getByRole("button",{name:"Edit Dashboard"}).click();
 await page.evaluate(()=>(window as any).prismRendererFixture.failTree=true);
 await page.getByRole("button",{name:"Edit widget",exact:true}).first().click();
 await expect(page.getByRole("status")).toContainText("Location hints are unavailable");
 await page.getByPlaceholder("Type to search paths...").fill("Keep/my/typed/path");
 await page.evaluate(()=>(window as any).prismRendererFixture.failTree=false);
 await page.getByRole("button",{name:"Retry location hints"}).click();
 await expect(page.getByText("Location hints are unavailable",{exact:false})).toHaveCount(0);
 await expect(page.getByPlaceholder("Type to search paths...")).toHaveValue("Keep/my/typed/path");
});
test("plain sheet cell editing persists the new value through the injected client",async({page})=>{
 await page.goto("/e2e-fixtures/renderer-preservation.html?kind=spreadsheet");
 await page.locator('input[value="First"]').fill("Edited row");
 await expect.poll(()=>page.evaluate(()=>(window as any).prismRendererFixture.notes().find((n:any)=>n.id==="spreadsheet").content)).toContain("Edited row");
 await page.reload();await expect(page.locator('input[value="Edited row"]')).toBeVisible();
 await expect(page.locator('input[value="=B2+1"]')).toBeVisible();
});
test("plain sheet failure retains changed cells and row operations preserve unchanged literal formulas",async({page})=>{
 await page.goto("/e2e-fixtures/renderer-preservation.html?kind=spreadsheet&fail");
 await page.getByLabel("Row 2, column 2",{exact:true}).fill("5");
 await expect(page.getByRole("alert")).toContainText("Changes could not be saved");
 await expect(page.getByLabel("Row 2, column 2",{exact:true})).toHaveValue("5");
 await page.evaluate(()=>(window as any).prismRendererFixture.fail=false);
 await page.getByRole("button",{name:"Retry save"}).click();
 await expect(page.getByRole("alert")).toHaveCount(0);
 await page.getByRole("button",{name:"+ Row",exact:true}).click();
 await page.getByLabel("Row 4, column 1",{exact:true}).fill("New row");
 await page.getByRole("button",{name:"+ Column",exact:true}).click();
 await page.getByLabel("Row 4, column 3",{exact:true}).fill("Keep me");
 await expect.poll(()=>page.evaluate(()=>(window as any).prismRendererFixture.notes().find((n:any)=>n.id==="spreadsheet").content)).toContain("New row,,Keep me");
 await page.reload();await expect(page.getByLabel("Row 3, column 2",{exact:true})).toHaveValue("=B2+1");await expect(page.getByLabel("Row 4, column 3",{exact:true})).toHaveValue("Keep me");
});
test("late widget path hints cannot populate a different workspace",async({page})=>{
 await page.goto("/e2e-fixtures/renderer-preservation.html?kind=dashboard");
 await page.getByRole("button",{name:"Edit Dashboard"}).click();
 await page.evaluate(()=>(window as any).prismRendererFixture.holdTree=true);
 await page.getByRole("button",{name:"Edit widget",exact:true}).first().click();
 await expect.poll(()=>page.evaluate(()=>(window as any).prismRendererFixture.releaseTree!==null)).toBe(true);
 await page.evaluate(()=>{const f=(window as any).prismRendererFixture;f.holdTree=false;f.switchScope();f.releaseTree();});
 const path=page.getByPlaceholder("Type to search paths...");
 await path.fill("Guest");
 await expect(page.getByRole("button",{name:"Guest directory",exact:true})).toBeVisible();
 await path.fill("Projects");
 await expect(page.getByRole("button",{name:"Projects/Prism/Research",exact:true})).toHaveCount(0);
 expect(await page.evaluate(()=>(window as any).prismRendererFixture.writes)).toEqual([]);
});
test("all current and legacy dashboard widgets render actual injected sources without route crashes",async({page})=>{
 const errors:string[]=[];const requests:string[]=[];
 page.on("pageerror",error=>errors.push(error.message));
 page.on("request",request=>{if(request.url().includes("/api/"))requests.push(request.url());});
 await page.goto("/e2e-fixtures/renderer-preservation.html?kind=dashboard&inventory&readonly");
 for(const type of ["gallery","progress","timeline","chart","embed","task-list","note-list","stat-card","calendar"])await expect(page.getByText(`Inventory: ${type}`,{exact:true})).toBeAttached();
 await expect(page.getByText("Linked document",{exact:true})).toBeAttached();
 await expect(page.getByText("Inventory: calendar",{exact:true}).locator("../..").getByText("Fictional planning session",{exact:true})).toBeAttached();
 expect(errors).toEqual([]);expect(requests).toEqual([]);
 expect(await page.evaluate(()=>(window as any).prismRendererFixture.writes)).toEqual([]);
});
