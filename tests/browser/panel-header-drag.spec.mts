import { test, expect, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';

type Pane = 'preview' | 'captions' | 'inspector';
const selectors = { preview:'.stage-column',captions:'.caption-panel',inspector:'.workspace-inspector' };
const orders:Pane[][] = [['preview','captions','inspector'],['preview','inspector','captions'],['captions','preview','inspector'],['inspector','preview','captions'],['captions','inspector','preview'],['inspector','captions','preview']];
let state:FixtureState; let errors:string[];
test.beforeAll(prepareFixtures); test.afterAll(cleanFixtures);
test.beforeEach(async ({ page }) => { errors=[]; page.on('pageerror',(error) => errors.push(error.message)); state=await installFixture(page); await page.setViewportSize({ width:2048,height:1041 }); });
test.afterEach(() => expect(errors).toEqual([]));
const grip = (page:Page,pane:Pane) => page.locator(`.refined-editor > ${selectors[pane]}`).getByRole('button',{ name:/^Drag .+ panel header to reorder$/ });
async function actualOrder(page:Page):Promise<Pane[]> {
  return page.locator('.refined-editor').evaluate((root) => [['preview','.stage-column'],['captions','.caption-panel'],['inspector','.workspace-inspector']]
    .map(([id,selector]) => ({ id,node:root.querySelector(`:scope > ${selector}`)! }))
    .filter(({ node }) => getComputedStyle(node).display !== 'none')
    .sort((a,b) => a.node.getBoundingClientRect().left-b.node.getBoundingClientRect().left).map(({ id }) => id)) as Promise<Pane[]>;
}
async function openEditor(page:Page,tool='Appearance') { await openProject(page); await page.getByRole('button',{ name:tool,exact:true }).click(); }
async function begin(page:Page,pane:Pane,x:number,y:number) {
  // Cancellation cases are isolated gestures. Rapid regrabs have their own
  // controlled-animation tests; don't click a stale point on a moving header.
  await expect(page.locator('.editor-pane-settling')).toHaveCount(0);
  const source=(await grip(page,pane).boundingBox())!;
  await page.mouse.move(source.x+source.width/2,source.y+source.height/2); await page.mouse.down(); await page.mouse.move(x,y,{ steps:5 });
  await expect(page.locator('.editor-pane-floating')).toBeVisible();
}
async function dragTo(page:Page,pane:Pane,target:Pane) {
  const box=(await page.locator(`.refined-editor > ${selectors[target]}`).boundingBox())!;
  await begin(page,pane,box.x+box.width/2,box.y+Math.min(100,box.height/2)); await page.mouse.up();
  await expect(page.locator('.editor-pane-floating')).toHaveCount(0);
  await expect(page.locator('.editor-pane-settling')).toHaveCount(0);
}
async function setOrder(page:Page,next:Pane[]) {
  for(let index=0;index<next.length;index++) {
    const order=await actualOrder(page);
    if(order.indexOf(next[index])!==index) await dragTo(page,next[index],order[index]);
  }
  await expect.poll(() => actualOrder(page)).toEqual(next);
}
const saved = (page:Page) => page.evaluate(() => localStorage.getItem('sthang:editor-layout:v2'));

test('actual headers reach every order, retain hidden Tool slots, and never open Arrange panels',async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => { (window as any).__headerVideo=document.querySelector('video'); (window as any).__headerCaptions=document.querySelector('.caption-panel'); });
  for(const order of orders) {
    await setOrder(page,order);
    const width=(await page.locator('.media-stage').boundingBox())!.width;
    await page.getByRole('button',{ name:'Close tool',exact:true }).click();
    await expect.poll(() => actualOrder(page)).toEqual(order.filter((pane) => pane!=='inspector'));
    expect((await page.locator('.media-stage').boundingBox())!.width).toBe(width);
    const visible=await actualOrder(page); await dragTo(page,visible[0],visible[1]);
    await page.getByRole('button',{ name:'Appearance',exact:true }).click();
    await expect.poll(() => actualOrder(page)).toEqual(order.map((pane) => pane==='preview' ? 'captions' : pane==='captions' ? 'preview' : pane));
    expect(await page.evaluate(() => (window as any).__headerVideo===document.querySelector('video') && (window as any).__headerCaptions===document.querySelector('.caption-panel'))).toBe(true);
    await expect(page.getByRole('region',{ name:'Arrange panels',exact:true })).toBeHidden();
  }
});

test('header keys preserve focus and expose playback controls without triggering timing shortcuts',async ({ page }) => {
  await openEditor(page,'Fine timing'); await expect(page.locator('.waveform-loading')).toHaveCount(0);
  const before=structuredClone(state.projects[0].captions); const preview=grip(page,'preview');
  await preview.press('End'); await expect.poll(() => actualOrder(page)).toEqual(['captions','inspector','preview']); await expect(preview).toBeFocused();
  await page.keyboard.press('Tab'); expect(await page.locator('video').evaluate((node) => document.activeElement===node)).toBe(true);
  await preview.press('Home'); await expect.poll(() => actualOrder(page)).toEqual(orders[0]);
  await preview.press('ArrowRight'); await expect.poll(() => actualOrder(page)).toEqual(['captions','preview','inspector']);
  await preview.press('Alt+ArrowRight'); await preview.press('Control+z'); await preview.press('r');
  expect(state.projects[0].captions).toEqual(before); expect(await page.locator('video').evaluate((node:HTMLVideoElement) => node.paused)).toBe(true);
  await expect.poll(() => actualOrder(page)).toEqual(['captions','preview','inspector']);
});

test('header accessible names track the visible tool and Review titles',async ({ page }) => {
  await openEditor(page); await expect(grip(page,'inspector')).toHaveAccessibleName('Drag Appearance panel header to reorder');
  await page.getByRole('button',{ name:'Fine timing',exact:true }).click();
  await expect(grip(page,'inspector')).toHaveAccessibleName('Drag Fine timing panel header to reorder');
  await page.getByRole('button',{ name:/^Review(?: \d+)?$/ }).first().click();
  await expect(grip(page,'captions')).toHaveAccessibleName('Drag Review queue panel header to reorder');
  await expect(grip(page,'captions')).toContainText('Review queue');
});

test('small clicks do not move panels and header action buttons remain independent',async ({ page }) => {
  await openEditor(page); const before=await saved(page); const box=(await grip(page,'preview').boundingBox())!;
  await page.mouse.move(box.x+10,box.y+10); await page.mouse.down(); await page.mouse.move(box.x+12,box.y+12); await page.mouse.up();
  await expect.poll(() => actualOrder(page)).toEqual(orders[0]); expect(await saved(page)).toBe(before); await expect(page.locator('.editor-pane-floating')).toHaveCount(0);
  await page.locator('.caption-panel').getByRole('button',{ name:'Following',exact:true }).click();
  await expect(page.locator('.caption-panel').getByRole('button',{ name:'Follow',exact:true })).toBeVisible();
  await page.locator('.caption-panel').getByRole('button',{ name:'Current',exact:true }).click();
  const count=await page.locator('.caption-row').count(); await page.getByRole('button',{ name:'Add caption',exact:true }).click(); await expect(page.locator('.caption-row')).toHaveCount(count+1);
  await expect.poll(() => actualOrder(page)).toEqual(orders[0]); await expect(page.locator('.editor-pane-floating')).toHaveCount(0);
  await page.getByRole('button',{ name:'Close tool',exact:true }).click(); await expect.poll(() => actualOrder(page)).toEqual(['preview','captions']);
});

test('drop hit-testing excludes toolbar, dividers, waveform and outside space, including release without final move',async ({ page }) => {
  await openEditor(page,'Fine timing'); await expect(page.locator('.waveform-loading')).toHaveCount(0);
  await dragTo(page,'preview','captions'); await expect.poll(() => actualOrder(page)).toEqual(['captions','preview','inspector']);
  const baseline=await saved(page);
  const separator=(await page.locator('.editor-divider:visible').first().boundingBox())!;
  const dock=(await page.locator('.editor-timing-dock').boundingBox())!;
  const toolbar=(await page.locator('.editor-toolbar').boundingBox())!;
  for(const point of [{ x:separator.x+4,y:separator.y+60 },{ x:dock.x+20,y:dock.y+50 },{ x:toolbar.x+20,y:toolbar.y+20 },{ x:1,y:800 }]) {
    await begin(page,'preview',point.x,point.y); await page.mouse.up();
    await expect.poll(() => actualOrder(page)).toEqual(['captions','preview','inspector']); expect(await saved(page)).toBe(baseline);
  }
  const target=(await page.locator('.caption-panel').boundingBox())!; await begin(page,'preview',target.x+100,target.y+100);
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchMouseEvent',{ type:'mouseReleased',x:separator.x+4,y:separator.y+60,button:'left',buttons:0,clickCount:1 });
  await page.mouse.up(); await cdp.detach(); await expect.poll(() => actualOrder(page)).toEqual(['captions','preview','inspector']); expect(await saved(page)).toBe(baseline);
});

test('Escape, lost capture, pointer cancellation and blur cancel header gestures without closing tools',async ({ page }) => {
  await openEditor(page); const before=await saved(page); const target=(await page.locator('.workspace-inspector').boundingBox())!;
  for(const cancel of ['escape','lost','pointercancel','blur']) {
    await begin(page,'preview',target.x+50,target.y+100);
    if(cancel==='escape') await page.keyboard.press('Escape');
    else if(cancel==='lost') await grip(page,'preview').evaluate((node) => node.releasePointerCapture(1));
    else if(cancel==='pointercancel') await grip(page,'preview').dispatchEvent('pointercancel',{ pointerId:1,pointerType:'mouse' });
    else await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.mouse.up(); await expect(page.locator('.editor-pane-floating')).toHaveCount(0); await expect(page.locator('.workspace-inspector')).toBeVisible();
    await expect.poll(() => actualOrder(page)).toEqual(orders[0]); expect(await saved(page)).toBe(before);
  }
});

test('height-only resize, breakpoint, Reset, tool close and tool change safely cancel captured header moves',async ({ page }) => {
  await openEditor(page);
  async function start() { const target=(await page.locator('.workspace-inspector').boundingBox())!; await begin(page,'preview',target.x+50,target.y+100); }
  await start(); await page.setViewportSize({ width:2048,height:900 }); await expect(page.locator('.editor-pane-floating')).toHaveCount(0); await page.mouse.up(); await expect.poll(() => actualOrder(page)).toEqual(orders[0]);
  await start(); await page.setViewportSize({ width:1100,height:900 }); await page.mouse.up(); await expect(page.locator('.editor-pane-grip')).toHaveCount(0);
  await page.setViewportSize({ width:2048,height:1041 }); await expect.poll(() => actualOrder(page)).toEqual(orders[0]);
  await grip(page,'preview').press('End'); await start(); await page.getByRole('button',{ name:'Reset layout',exact:true }).focus(); await page.keyboard.press('Enter'); await page.mouse.up(); await expect.poll(() => actualOrder(page)).toEqual(orders[0]);
  await start(); await page.getByRole('button',{ name:'Close tool',exact:true }).focus(); await page.keyboard.press('Enter'); await page.mouse.up(); await expect.poll(() => actualOrder(page)).toEqual(['preview','captions']);
  await page.getByRole('button',{ name:'Appearance',exact:true }).click(); await start(); await page.getByRole('button',{ name:'Fine timing',exact:true }).focus(); await page.keyboard.press('Enter'); await page.mouse.up();
  await expect(page.locator('.editor-pane-floating')).toHaveCount(0); await expect.poll(() => actualOrder(page)).toEqual(orders[0]); await expect(grip(page,'inspector')).toContainText('Fine timing');
});

test('direct dragging closes an open Arrange popup and competing popup/resize/second-pointer actions cannot override it',async ({ page }) => {
  await openEditor(page); await page.getByRole('button',{ name:'Arrange panels',exact:true }).click();
  const before=await saved(page);
  const target=(await page.locator('.caption-panel').boundingBox())!;
  await begin(page,'preview',target.x+target.width/2,target.y+100);
  await expect(page.getByRole('region',{ name:'Arrange panels',exact:true })).toBeHidden(); await expect(page.getByRole('button',{ name:'Arrange panels',exact:true })).toBeDisabled();
  expect(await page.locator('.editor-pane-floating').evaluate((node) => node.parentElement===document.querySelector('.refined-editor'))).toBe(true);
  const widths=await page.locator('.stage-column').evaluate((node) => node.getBoundingClientRect().width);
  await page.locator('.editor-divider:visible').first().press('ArrowRight'); expect(await page.locator('.stage-column').evaluate((node) => node.getBoundingClientRect().width)).toBe(widths);
  await page.getByRole('button',{ name:'Move Tool panel left',exact:true,includeHidden:true }).evaluate((node:HTMLButtonElement) => node.click());
  await grip(page,'inspector').dispatchEvent('pointerdown',{ pointerId:77,button:0,pointerType:'touch' });
  expect(await saved(page)).toBe(before); await expect(page.locator('.editor-pane-floating')).toHaveCount(1);
  await expect(page.locator('.refined-editor')).toHaveAttribute('data-header-drag-order','captions,preview,inspector');
  await page.mouse.up(); await expect.poll(() => actualOrder(page)).toEqual(['captions','preview','inspector']);
});

test('the actual panel lifts, neighbours slide into insertion order, and reversing or holding never jitters or saves a draft',async ({ page },info) => {
  await openEditor(page); const before=await saved(page);
  const preview=(await page.locator('.stage-column').boundingBox())!;
  const captions=(await page.locator('.caption-panel').boundingBox())!;
  const tool=(await page.locator('.workspace-inspector').boundingBox())!;
  const header=(await grip(page,'preview').boundingBox())!;
  await page.evaluate(() => { (window as any).__liftedVideo=document.querySelector('video'); });
  const x=tool.x+tool.width/2; const y=preview.y+110;
  await begin(page,'preview',x,y);
  await expect(page.locator('.refined-editor')).toHaveAttribute('data-header-drag-order','captions,inspector,preview');
  await expect.poll(async () => Math.round((await page.locator('.caption-panel').boundingBox())!.x)).toBe(Math.round(preview.x));
  await expect.poll(async () => Math.round((await page.locator('.workspace-inspector').boundingBox())!.x)).toBe(Math.round(preview.x+captions.width+8));
  const floating=(await page.locator('.stage-column').boundingBox())!;
  expect(floating.x-preview.x).toBeCloseTo(x-header.x-header.width/2,0);
  expect(floating.y-preview.y).toBeCloseTo(y-header.y-header.height/2,0);
  await expect(page.locator('.editor-panel-placeholder')).toBeVisible();
  await expect(page.locator('.editor-panel-ghost')).toHaveCount(0);
  for(let index=0;index<8;index++) await page.mouse.move(x,y);
  await expect(page.locator('.refined-editor')).toHaveAttribute('data-header-drag-order','captions,inspector,preview');
  expect(await saved(page)).toBe(before);
  await page.screenshot({ path:info.outputPath('actual-panel-lift-and-insertion.png'),fullPage:true });
  const shifted=(await page.locator('.workspace-inspector').boundingBox())!;
  await page.mouse.move(shifted.x+shifted.width/2-2,y);
  await expect(page.locator('.refined-editor')).toHaveAttribute('data-header-drag-order','captions,preview,inspector');
  await page.mouse.move(preview.x+50,y);
  await expect(page.locator('.refined-editor')).toHaveAttribute('data-header-drag-order','preview,captions,inspector');
  await page.mouse.move(x,y); await page.mouse.up(); await expect(page.locator('.editor-pane-settling')).toHaveCount(0);
  await expect.poll(() => actualOrder(page)).toEqual(['captions','inspector','preview']);
  expect(await page.evaluate(() => document.querySelector('video')===(window as any).__liftedVideo)).toBe(true);
  await expect(page.locator('.editor-pane-floating,.editor-pane-shifting')).toHaveCount(0);
});

test('reduced motion keeps direct tracking and insertion feedback with no neighbour or landing animation',async ({ page }) => {
  await page.emulateMedia({ reducedMotion:'reduce' }); await openEditor(page);
  const target=(await page.locator('.workspace-inspector').boundingBox())!;
  await begin(page,'preview',target.x+target.width/2,target.y+100);
  await expect(page.locator('.refined-editor')).toHaveAttribute('data-header-drag-order','captions,inspector,preview');
  expect(await page.locator('.editor-pane-shifting').first().evaluate((node) => getComputedStyle(node).transitionProperty)).toBe('none');
  await page.keyboard.press('Escape'); await page.mouse.up(); await expect(page.locator('.editor-pane-settling,.editor-pane-floating,.editor-pane-shifting')).toHaveCount(0);
  await expect.poll(() => actualOrder(page)).toEqual(orders[0]);
});

for(const dimension of ['width','height'] as const) test(`release before ${dimension} resize notifications cannot save the provisional order`,async ({ page }) => {
  await openEditor(page); const before=await saved(page);
  const target=(await page.locator('.workspace-inspector').boundingBox())!;
  const x=target.x+target.width/2; const y=target.y+100;
  await begin(page,'preview',x,y);
  await expect(page.locator('.refined-editor')).toHaveAttribute('data-header-drag-order','captions,inspector,preview');
  await grip(page,'preview').evaluate((handle,{ dimension,x,y }) => {
    const root=document.querySelector<HTMLElement>('.refined-editor')!;
    const rect=root.getBoundingClientRect();
    const previous={ flex:root.style.flex,width:root.style.width,height:root.style.height };
    root.style.flex='none'; root.style.width=`${rect.width}px`; root.style.height=`${rect.height}px`;
    root.style[dimension]=`${rect[dimension]-80}px`;
    handle.dispatchEvent(new PointerEvent('pointerup',{ bubbles:true,pointerId:1,button:0,clientX:x,clientY:y }));
    Object.assign(root.style,previous);
  },{ dimension,x,y });
  await page.mouse.up();
  await expect(page.locator('.editor-pane-floating,.editor-pane-shifting,.editor-pane-settling')).toHaveCount(0);
  await expect.poll(() => actualOrder(page)).toEqual(orders[0]); expect(await saved(page)).toBe(before);
});

test('a real header touch cancels a pending timing drag without changing caption times',async ({ page }) => {
  await openEditor(page,'Fine timing'); await expect(page.locator('.waveform-loading')).toHaveCount(0); const before=structuredClone(state.projects[0].captions);
  const canvas=(await page.locator('.waveform-data-canvas').boundingBox())!;
  await page.mouse.move(canvas.x+canvas.width*.15,canvas.y+155); await page.mouse.down(); await expect(page.locator('.waveform-canvas-wrap')).toHaveClass(/dragging/);
  const header=(await grip(page,'preview').boundingBox())!; const target=(await grip(page,'inspector').boundingBox())!;
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent',{ type:'touchStart',touchPoints:[{ id:1,x:header.x+20,y:header.y+15 }] });
  await expect(page.locator('.waveform-canvas-wrap')).not.toHaveClass(/dragging/);
  await cdp.send('Input.dispatchTouchEvent',{ type:'touchMove',touchPoints:[{ id:1,x:target.x+20,y:target.y+15 }] }); await expect(page.locator('.editor-pane-floating')).toBeVisible();
  await cdp.send('Input.dispatchTouchEvent',{ type:'touchCancel',touchPoints:[] });
  await page.mouse.move(canvas.x+canvas.width*.3,canvas.y+155); await page.mouse.up(); await cdp.detach();
  expect(state.projects[0].captions).toEqual(before); await expect.poll(() => actualOrder(page)).toEqual(orders[0]);
});

test('playing media, caption text/caret, list scroll and paused Follow survive direct-header moves',async ({ page },info) => {
  state.projects[0].captions=Array.from({ length:20 },(_,index) => ({ id:`header-${index}`,startMs:index*180,endMs:index*180+160,text:`Caption ${index+1}`,timingQuality:'high',timingSource:'stt' }));
  await openEditor(page); const text=page.getByLabel('Caption 2 text',{ exact:true }); await text.fill('Keep this caption edit'); await text.evaluate((node:HTMLTextAreaElement) => node.setSelectionRange(3,9));
  const list=page.locator('.caption-list'); await list.hover(); await page.mouse.wheel(0,350); await expect(page.locator('.caption-panel').getByRole('button',{ name:'Follow',exact:true })).toBeVisible(); const top=await list.evaluate((node) => node.scrollTop);
  await page.locator('video').evaluate(async (node:HTMLVideoElement) => { (window as any).__directVideo=node;(window as any).__directList=document.querySelector('.caption-list');(window as any).__directPauses=0;node.loop=true;node.addEventListener('pause',() => (window as any).__directPauses++);await node.play(); });
  await dragTo(page,'preview','inspector'); await expect.poll(() => actualOrder(page)).toEqual(['captions','inspector','preview']);
  expect(await page.locator('video').evaluate((node:HTMLVideoElement) => node===(window as any).__directVideo && !node.paused)).toBe(true); expect(await page.evaluate(() => (window as any).__directPauses)).toBe(0);
  expect(await list.evaluate((node) => node===(window as any).__directList)).toBe(true);
  expect(await list.evaluate((node) => node.scrollTop)).toBe(top); await expect(text).toHaveValue('Keep this caption edit'); expect(await text.evaluate((node:HTMLTextAreaElement) => [node.selectionStart,node.selectionEnd])).toEqual([3,9]);
  await expect(page.locator('.caption-panel').getByRole('button',{ name:'Follow',exact:true })).toBeVisible();
  await page.screenshot({ path:info.outputPath('direct-header-preview-right.png'),fullPage:true });
});

for(const fallback of ['narrow','unsupported']) test(`plain readable headers remain in ${fallback} layouts`,async ({ page }) => {
  if(fallback==='narrow') await page.setViewportSize({ width:1100,height:900 });
  else await page.addInitScript(() => { const supports=CSS.supports.bind(CSS);CSS.supports=((...args:string[]) => args[0]==='reading-flow' ? false : (supports as any)(...args)) as typeof CSS.supports; });
  await openEditor(page); await expect(page.locator('.editor-pane-grip')).toHaveCount(0);
  await expect(page.locator('.editor-preview-label strong')).toHaveText('Preview'); await expect(page.locator('.panel-head-copy strong')).toHaveText('Captions'); await expect(page.locator('.inspector-heading strong')).toHaveText('Appearance');
});
