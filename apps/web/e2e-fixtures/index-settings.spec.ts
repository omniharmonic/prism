import { test, expect } from "@playwright/test";

test("phone search settings show durable progress with pause and resume",async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto('/e2e-fixtures/index-settings.html');
  await expect(page.getByText('128 notes indexed',{exact:false})).toBeVisible();
  await page.getByRole('button',{name:'Update search',exact:true}).click();
  await expect(page.getByText('Updating search…',{exact:false})).toBeVisible();
  await expect(page.getByRole('progressbar',{name:'Search update progress'})).toHaveAttribute('value','10');
  await page.getByRole('button',{name:'Pause update'}).click();
  await expect(page.getByText('Update paused',{exact:false})).toBeVisible();
  await page.getByRole('button',{name:'Resume update'}).click();
  await expect(page.getByRole('button',{name:'Pause update'})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/index-settings-mobile.png'});
});

test("failed controls preserve progress and permission loss hides cached counts",async({page})=>{
  await page.goto('/e2e-fixtures/index-settings.html');
  await page.getByRole('button',{name:'Update search',exact:true}).click();
  await expect(page.getByRole('button',{name:'Pause update'})).toBeVisible();
  await page.evaluate(()=>{(window as any).prismIndexFixture.fail=true;});
  await page.getByRole('button',{name:'Pause update'}).click();
  await expect(page.getByRole('alert')).toContainText('Another search update');
  await expect(page.getByRole('progressbar')).toHaveAttribute('value','10');
  await page.evaluate(()=>{(window as any).prismIndexFixture.deny=true;});
  await page.getByRole('button',{name:'Refresh status'}).click();
  await expect(page.getByText('Couldn’t check search.',{exact:false})).toBeVisible();
  await expect(page.getByText('128 notes indexed',{exact:false})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Pause update'})).toHaveCount(0);
});

test("a late response from the old vault cannot populate the new vault's status",async({page})=>{
  await page.goto('/e2e-fixtures/index-settings.html');
  await expect(page.getByText('128 notes indexed',{exact:false})).toBeVisible();
  await page.evaluate(()=>{(window as any).prismIndexFixture.hold=true;});
  await page.getByRole('button',{name:'Refresh status'}).click();
  await expect.poll(()=>page.evaluate(()=>!!(window as any).prismIndexFixture.release)).toBe(true);
  await page.evaluate(()=>{
    const c=(window as any).prismIndexFixture;c.hold=false;
    (window as any).prismIndexStore.setState({scope:'b'});c.release();
  });
  await expect(page.getByText('4 notes indexed',{exact:false})).toBeVisible();
  await expect(page.getByText('128 notes indexed',{exact:false})).toHaveCount(0);
  const calls=await page.evaluate(()=>(window as any).prismIndexFixture.calls);
  expect(calls.map((c:any)=>c.vault)).toEqual(['a','a','b']);
});
