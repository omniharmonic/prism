import {test,expect} from '@playwright/test';

test('ambiguous links offer full paths and recheck access before opening',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto('/e2e-fixtures/wikilinks.html');
  const link=page.getByRole('link',{name:'Report',exact:true});
  await link.focus();await expect(link).toBeFocused();await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog',{name:'Open linked document'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Report Journal/Report'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Report Projects/Report'})).toBeVisible();
  await page.screenshot({path:'test-results/wikilink-chooser-mobile.png'});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.evaluate(()=>{(window as any).prismLinkFixture.denied.push('a');});
  await page.getByRole('button',{name:'Report Projects/Report'}).click();
  await expect(page.getByRole('alert')).toContainText('access has changed');
  expect(await page.evaluate(()=>(window as any).prismLinkFixture.opened)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(link).toBeFocused();
});

test('aliases resolve consistently and late responses cannot navigate another audience',async({page})=>{
  await page.goto('/e2e-fixtures/wikilinks.html');
  await page.getByRole('link',{name:'This week'}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).prismLinkFixture.opened)).toEqual(['a']);
  await page.evaluate(()=>{(window as any).prismLinkFixture.hold=true;});
  await page.getByRole('link',{name:'Report',exact:true}).click();
  await expect(page.getByText('Checking this link…')).toBeVisible();
  await page.evaluate(()=>{(window as any).prismLinkStore.setState({scope:'fixture-b'});(window as any).prismLinkFixture.release();});
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(()=>(window as any).prismLinkFixture.opened)).toEqual(['a']);
});

test('autocomplete supports keyboard selection, stores stable IDs, and keeps titles as literal text',async({page,browserName})=>{
  await page.goto('/e2e-fixtures/wikilinks.html');
  await expect(page.getByRole('textbox',{name:'Document'})).toBeVisible();
  await page.evaluate(()=>{(window as any).prismLinkFixture.editor.commands.setContent('<p></p>');});
  const editor=page.getByRole('textbox',{name:'Document'});
  await editor.click();await page.keyboard.type('[[Report');
  await expect(page.getByRole('listbox',{name:'Link to a document'})).toBeVisible();
  await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
  await expect(editor).toContainText('[[b|Report]]');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await page.evaluate(()=>{(window as any).prismLinkFixture.notes[1].path='Journal/Renamed';});
  await page.getByRole('link',{name:'Report',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).prismLinkFixture.opened)).toEqual(['b']);
  await editor.click();await page.keyboard.press('ControlOrMeta+End');await page.keyboard.type('[[Literal');
  await expect(page.getByRole('option')).toContainText('<b>Literal</b>');
  await page.keyboard.press('Tab');
  await expect(editor).toContainText('[[literal|<b>Literal</b>]]');
  expect(await editor.locator('b,strong').count()).toBe(0);
  expect(await page.evaluate(()=>(window as any).prismLinkFixture.editor.getText())).toContain('[[literal|<b>Literal</b>]]');
  if (browserName === 'chromium') {
    await page.context().grantPermissions(['clipboard-read','clipboard-write']);
    await editor.focus();await page.keyboard.press('ControlOrMeta+a');await page.keyboard.press('ControlOrMeta+c');
    expect(await page.evaluate(()=>navigator.clipboard.readText())).toContain('[[literal|<b>Literal</b>]]');
    await page.evaluate(()=>{(window as any).prismLinkFixture.editor.commands.setContent('<p></p>');});
    await editor.focus();await page.keyboard.press('ControlOrMeta+v');
  } else {
    // WebKit automation has no clipboard permission grant. Exercise its real
    // editor copy/paste handlers with a DataTransfer; OS clipboard proof is separate.
    const copied = await page.evaluate(()=>{
      const editor=(window as any).prismLinkFixture.editor;
      editor.chain().focus().selectAll().run();
      const clipboardData=new DataTransfer();
      editor.view.dom.dispatchEvent(new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData}));
      const text=clipboardData.getData('text/plain');
      editor.commands.setContent('<p></p>');
      editor.commands.focus();
      editor.view.dom.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData}));
      return text;
    });
    expect(copied).toContain('[[literal|<b>Literal</b>]]');
  }
  await expect(editor).toContainText('[[literal|<b>Literal</b>]]');
});
