import {test,expect} from '@playwright/test';
test('brand stays five inputs and one output with compact optical sizing',async({page},testInfo)=>{
 await page.setViewportSize({width:1000,height:950});
 await page.goto('/e2e-fixtures/brand.html');
 const light=page.getByRole('region',{name:'Light brand'});
 await expect(light.getByRole('img')).toHaveCount(18);
 const small=light.locator('svg[width="24"]').last();
 await expect(small.locator('path[stroke-linecap="round"]')).toHaveCount(6);
 await expect(small.locator('path[d="M54 32H91"]')).toHaveAttribute('stroke-width','4.8');
 await expect(light.locator('svg[width="96"]').last().locator('path[d="M54 9V55M31 55 54 32 77 55"]')).toHaveCount(1);
 await page.screenshot({path:testInfo.outputPath('brand-real-sizes.png'),fullPage:true});
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.evaluate(()=>document.documentElement.style.zoom='2');
 await page.screenshot({path:testInfo.outputPath('brand-200-percent.png'),fullPage:true});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(1000);
});
