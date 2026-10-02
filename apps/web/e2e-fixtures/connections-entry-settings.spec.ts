import {test,expect} from '@playwright/test';
test('device settings sends the user to authority-gated workspace settings',async({page})=>{
 await page.goto('/e2e-fixtures/workspace.html');
 await page.evaluate(()=>(window as any).prismFixtureUI.getState().setSettingsOpen(true));
 const dialog=page.getByRole('dialog',{name:'Settings',exact:true});
 await dialog.getByRole('button',{name:'Services',exact:true}).click();
 await expect(dialog).toContainText('Workspace settings → Connections');
 await dialog.getByRole('button',{name:'Open workspace settings',exact:true}).click();
 await expect(dialog).toHaveCount(0);
 expect(await page.evaluate(()=>(window as any).prismFixtureUI.getState().activeTabId)).toBe('tab-network');
});
