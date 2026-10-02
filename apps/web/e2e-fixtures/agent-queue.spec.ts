import { test, expect } from "@playwright/test";
async function start(page: any) {
  await page.goto("/e2e-fixtures/agent.html?queue&context");
  await page
    .getByRole("textbox", { name: "Message the agent" })
    .fill("First instruction");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Queue follow-up" }),
  ).toBeVisible();
}
test("follow-ups are visibly queued, survive reload, preserve edits on failure and can be removed", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("textbox", { name: "Message the agent" })
    .fill("Second instruction");
  await page.getByRole("button", { name: "Queue follow-up" }).click();
  await expect(
    page.getByRole("region", { name: "Queued follow-ups" }),
  ).toContainText("Second instruction");
  await expect(
    page.getByRole("textbox", { name: "Message the agent" }),
  ).toHaveValue("");
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Queued follow-ups" }),
  ).toContainText("Second instruction");
  await page
    .getByRole("region", { name: "Queued follow-ups" })
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Queued instruction" })
    .fill("Revised second instruction");
  await page.evaluate(() => {
    (window as any).prismAgentFixture.rejectQueueChange = true;
  });
  await page.getByRole("button", { name: "Save queued message" }).click();
  await expect(page.getByRole("dialog")).toContainText("Your draft is kept");
  await expect(
    page.getByRole("textbox", { name: "Queued instruction" }),
  ).toHaveValue("Revised second instruction");
  await page.evaluate(() => {
    (window as any).prismAgentFixture.rejectQueueChange = false;
  });
  await page.getByRole("button", { name: "Save queued message" }).click();
  await expect(
    page.getByRole("region", { name: "Queued follow-ups" }),
  ).toContainText("Revised second instruction");
  await page.getByRole("button", { name: "Remove queued message 1" }).click();
  await expect(
    page.getByRole("region", { name: "Queued follow-ups" }),
  ).not.toBeVisible();
});
test("lost queue acknowledgements retain the draft and retry the same durable request", async ({
  page,
}) => {
  await start(page);
  await page.evaluate(() => {
    (window as any).prismAgentFixture.loseQueueResponse = true;
  });
  await page
    .getByRole("textbox", { name: "Message the agent" })
    .fill("Retry-safe follow-up");
  await page.getByRole("button", { name: "Queue follow-up" }).click();
  await expect(
    page.getByText("Fixture queue response lost", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Message the agent" }),
  ).toHaveValue("Retry-safe follow-up");
  await page.evaluate(()=>{(window as any).prismAgentFixture.finishCurrent();});
  await page.reload();
  await expect(page.getByRole("button", { name: "Stop", exact:true })).not.toBeVisible();
  await page.getByRole("button", { name: "Check queued message" }).click();
  await expect(
    page.getByRole("textbox", { name: "Message the agent" }),
  ).toHaveValue("");
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("fixture-followups") ?? "[]").length,
    ),
  ).toBe(1);
});
test("paused follow-ups require review of current permissions and work on a phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page);
  await page
    .getByRole("textbox", { name: "Message the agent" })
    .fill("Paused instruction");
  await page.getByRole("button", { name: "Queue follow-up" }).click();
  await expect(page.getByRole("region", { name: "Queued follow-ups" })).toContainText("Paused instruction");
  await page.evaluate(() => {
    (window as any).prismAgentFixture.pauseQueue();
  });
  await expect(
    page.getByRole("button", { name: "Review & resume" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Review & resume" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "current permissions: Read-only",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Resume with these permissions" })
    .click();
  await expect(
    page.getByRole("button", { name: "Review & resume" }),
  ).not.toBeVisible();
  await page.screenshot({ path: "test-results/agent-queue-mobile.png" });
});

test('checking an uncertain queue receipt preserves a newly edited composer draft',async({page})=>{
 await start(page);
 await page.evaluate(()=>{(window as any).prismAgentFixture.loseQueueResponse=true;});
 const input=page.getByRole('textbox',{name:'Message the agent'});
 await input.fill('Original queued instruction');await page.getByRole('button',{name:'Queue follow-up'}).click();
 await expect(page.getByText('Fixture queue response lost',{exact:false})).toBeVisible();
 await input.fill('A different next instruction');
 await page.evaluate(()=>{(window as any).prismAgentFixture.finishCurrent();});await page.reload();
 await page.getByRole('button',{name:'Check queued message'}).click();
 await expect(input).toHaveValue('A different next instruction');
 await expect(page.getByRole('button',{name:'Check queued message'})).not.toBeVisible();
 const rows=await page.evaluate(()=>JSON.parse(localStorage.getItem('fixture-followups')??'[]'));
 expect(rows).toHaveLength(1);expect(rows[0].payload.prompt).toBe('Original queued instruction');
});
test('queueing stops before execution when its durable pending receipt cannot be saved',async({page})=>{
 await start(page);
 await page.evaluate(()=>{const original=Storage.prototype.setItem;(window as any).restoreQueueStorage=()=>Storage.prototype.setItem=original;Storage.prototype.setItem=function(key,value){if(key.includes('pending-followup'))throw Error('quota');return original.call(this,key,value);};});
 await page.getByRole('textbox',{name:'Message the agent'}).fill('Keep my queued instruction');
 await page.getByRole('button',{name:'Queue follow-up'}).click();
 await expect(page.getByText('Prism could not save the queue receipt.',{exact:false})).toBeVisible();
 expect(await page.evaluate(()=>(window as any).prismAgentFixture.queueAttempts)).toBe(0);
 await page.evaluate(()=>(window as any).restoreQueueStorage());
 await page.getByRole('button',{name:'Check queued message'}).click();
 await expect(page.getByRole('region',{name:'Queued follow-ups'})).toContainText('Keep my queued instruction');
 expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('fixture-followups')??'[]').length)).toBe(1);
});

test('queued context previews retain the instruction and recheck revoked source access',async({page})=>{
 await page.goto('/e2e-fixtures/agent.html?queue&context&snapshots');
 const composer=page.getByRole('textbox',{name:'Message the agent'});
 await composer.fill('First instruction');await page.getByRole('button',{name:'Send',exact:true}).click();
 await expect(page.getByRole('button',{name:'Queue follow-up'})).toBeVisible();
 await page.getByText('Capture text',{exact:true}).click();
 await page.getByRole('button',{name:'Attach document snapshot',exact:true}).click();
 await composer.fill('Discuss captured context');await page.getByRole('button',{name:'Queue follow-up'}).click();
 await page.getByRole('region',{name:'Queued follow-ups'}).getByRole('button',{name:'Edit',exact:true}).click();
 const editor=page.getByRole('dialog',{name:'Edit queued message'});
 await editor.getByRole('textbox',{name:'Queued instruction'}).fill('Keep this edited instruction');
 await editor.getByRole('button',{name:'Preview captured document 1'}).click();
 const preview=page.getByRole('dialog',{name:'Captured context'});
 await expect(preview).toContainText('Initial captured draft.');
 await preview.press('Escape');
 await expect(editor.getByRole('textbox',{name:'Queued instruction'})).toHaveValue('Keep this edited instruction');
 await expect(editor.getByRole('button',{name:'Preview captured document 1'})).toBeFocused();
 await page.evaluate(()=>{(window as any).prismAgentFixture.denySource=true;});
 await editor.getByRole('button',{name:'Preview captured document 1'}).click();
 await expect(preview).toContainText('This source is unavailable');
 await expect(preview).not.toContainText('Initial captured draft.');
 await preview.press('Escape');
 await editor.getByRole('button',{name:'Preview working document'}).click();
 const saved=page.getByRole('dialog',{name:'Source preview'});
 await expect(saved).toContainText('This source is unavailable');
 await expect(saved).not.toContainText('Fixture');
 await saved.press('Escape');
 await editor.getByRole('button',{name:'Save queued message'}).click();
 await expect(editor).not.toBeVisible();
 await expect(page.getByRole('region',{name:'Queued follow-ups'})).toContainText('Keep this edited instruction');
});
