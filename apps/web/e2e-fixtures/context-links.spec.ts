import {test,expect} from '@playwright/test';

test('links resolve twenty at a time with explicit directions and fresh authorized opening',async({page})=>{
 await page.goto('/e2e-fixtures/context-links.html');
 await expect(page.getByRole('button',{name:'Open Field notes',exact:true})).toBeVisible();
 await expect(page.getByRole('region',{name:'Links to this page'})).toContainText('Field notes');
 await expect(page.getByRole('region',{name:'Links from this page'})).toContainText('Weekly review');
 expect(await page.evaluate(()=>(window as any).contextLinks.reads.length)).toBe(21);
 await expect(page.getByRole('button',{name:'Open Research note 24',exact:true})).not.toBeVisible();
 await page.getByRole('button',{name:'Load more connections (5 remaining)'}).click();
 await expect(page.getByRole('button',{name:'Open Research note 24',exact:true})).toBeVisible();
 await page.evaluate(()=>{(window as any).contextLinks.rename=true;});
 await page.getByRole('button',{name:'Open Field notes',exact:true}).click();
 expect(await page.evaluate(()=>(window as any).contextLinks.ui.getState().openTabs[0]?.title)).toBe('Updated title');
 expect(await page.evaluate(()=>(window as any).contextLinks.reads.every((r:any)=>r.fresh))).toBe(true);
 expect(await page.evaluate(()=>(window as any).contextLinks.writes)).toBe(0);
});

test('failures, denied notes and denied opening never become empty success or raw IDs',async({page})=>{
 await page.goto('/e2e-fixtures/context-links.html?small');
 await expect(page.getByRole('button',{name:'Open Field notes',exact:true})).toBeVisible();
 await page.evaluate(()=>{const c=(window as any).contextLinks;c.failLinks=true;void c.query.invalidateQueries({queryKey:['vault','links']});});
 await expect(page.getByRole('alert')).toContainText('Connections could not be loaded');
 await expect(page.getByText('No connections yet.')).not.toBeVisible();
 await expect(page.getByRole('button',{name:'Open Field notes',exact:true})).not.toBeVisible();
 await page.evaluate(()=>{const c=(window as any).contextLinks;c.failLinks=false;c.deny.add('linked-id-0');c.fail.add('linked-id-1');});
 await page.getByRole('button',{name:'Try again',exact:true}).click();
 await expect(page.getByText('Unavailable linked note',{exact:true})).toBeVisible();
 await expect(page.getByText('Linked note could not be loaded',{exact:true})).toBeVisible();
 await expect(page.locator('main')).not.toContainText('linked-id-');
 await expect(page.locator('main')).not.toContainText('private diagnostics');
 await page.evaluate(()=>{(window as any).contextLinks.deny.add('linked-id-2');});
 await page.getByRole('button',{name:'Open Workspace principles',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('could not be opened');
 await expect(page.locator('main')).not.toContainText('Workspace principles');
 expect(await page.evaluate(()=>(window as any).contextLinks.ui.getState().openTabs.length)).toBe(0);
});

test('scope and document changes cancel late openings and hide old titles during refresh',async({page})=>{
 await page.goto('/e2e-fixtures/context-links.html?small');
 await expect(page.getByRole('button',{name:'Open Field notes',exact:true})).toBeVisible();
 await page.evaluate(()=>{(window as any).contextLinks.hold=true;});
 await page.getByRole('button',{name:'Open Field notes',exact:true}).click();
 await page.getByRole('button',{name:'Switch workspace'}).click();
 await expect(page.locator('main')).not.toContainText('Field notes');
 await page.evaluate(()=>{const c=(window as any).contextLinks;c.hold=false;c.pending.splice(0).forEach((r:()=>void)=>r());});
 await expect(page.getByRole('button',{name:'Open New workspace note'})).toHaveCount(3);
 expect(await page.evaluate(()=>(window as any).contextLinks.ui.getState().openTabs.length)).toBe(0);
 await page.evaluate(()=>{(window as any).contextLinks.hold=true;});
 await page.getByRole('button',{name:'Open New workspace note'}).first().click();
 await page.getByRole('button',{name:'Switch document'}).click();
 await expect(page.getByText('Loading connections…')).toBeVisible();
 await page.evaluate(()=>{const c=(window as any).contextLinks;c.hold=false;c.pending.splice(0).forEach((r:()=>void)=>r());});
 await expect(page.getByRole('button',{name:'Open New workspace note'})).toHaveCount(3);
 expect(await page.evaluate(()=>(window as any).contextLinks.ui.getState().openTabs.length)).toBe(0);
});

for(const mode of ['empty','unsupported'])test(`${mode} connection state is truthful`,async({page})=>{
 await page.goto('/e2e-fixtures/context-links.html?'+mode);
 await expect(page.getByText(mode==='empty'?'No connections yet.':'This connection does not provide note links.')).toBeVisible();
 expect(await page.evaluate(()=>(window as any).contextLinks.writes)).toBe(0);
});

for(const appearance of ['desktop','phone','dark'])test(`related context visual ${appearance}`,async({page},info)=>{
 await page.setViewportSize(appearance==='phone'?{width:390,height:844}:{width:980,height:900});
 await page.goto('/e2e-fixtures/context-links.html?small'+(appearance==='dark'?'&dark':''));
 await expect(page.getByRole('button',{name:'Open Workspace principles',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.locator('main').screenshot({path:info.outputPath(`links-${appearance}.png`)});
});

test('target resolution is parallel and bounded; source revocation hides cached relationships',async({page})=>{
 await page.goto('/e2e-fixtures/context-links.html?parallel');
 await expect(page.getByText('Loading linked notes…')).toBeVisible();
 await expect.poll(()=>page.evaluate(()=>(window as any).contextLinks.pending.length)).toBe(20);
 expect(await page.evaluate(()=>(window as any).contextLinks.reads.length)).toBe(21);
 await page.evaluate(()=>{const c=(window as any).contextLinks;c.holdTargets=false;c.pending.splice(0).forEach((r:()=>void)=>r());});
 await expect(page.getByRole('button',{name:'Open Field notes',exact:true})).toBeVisible();
 await page.evaluate(()=>{const c=(window as any).contextLinks;c.hold=true;void c.query.invalidateQueries({queryKey:['vault','links']});});
 await expect(page.getByText('Loading connections…')).toBeVisible();
 await expect(page.locator('main')).not.toContainText('Field notes');
 await page.evaluate(()=>{const c=(window as any).contextLinks;c.hold=false;c.denySource=true;c.pending.splice(0).forEach((r:()=>void)=>r());});
 await expect(page.getByRole('alert')).toContainText('This page is unavailable');
 await expect(page.locator('main')).not.toContainText('Field notes');
 expect(await page.evaluate(()=>(window as any).contextLinks.linkReads)).toBe(1);
});
