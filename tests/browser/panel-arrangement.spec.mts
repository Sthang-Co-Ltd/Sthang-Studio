import { test, expect, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';

let state: FixtureState;
let runtimeErrors:string[];
const labels = { preview: 'Preview', captions: 'Captions', inspector: 'Tool' };
type Pane = keyof typeof labels;
const orders: Pane[][] = [['preview','captions','inspector'],['preview','inspector','captions'],['captions','preview','inspector'],['inspector','preview','captions'],['captions','inspector','preview'],['inspector','captions','preview']];
test.beforeAll(prepareFixtures); test.afterAll(cleanFixtures);
test.beforeEach(async ({ page }) => { runtimeErrors=[]; page.on('pageerror',(error) => runtimeErrors.push(error.message)); state = await installFixture(page); await page.setViewportSize({ width: 2048, height: 1041 }); });
test.afterEach(() => expect(runtimeErrors).toEqual([]));
async function arrange(page: Page) {
  const panel = page.getByRole('region', { name: 'Arrange panels', exact: true });
  if (!await panel.isVisible()) await page.getByRole('button', { name: 'Arrange panels', exact: true }).click();
  await expect(panel).toBeVisible(); return panel;
}
async function actualOrder(page: Page): Promise<Pane[]> {
  return page.locator('.refined-editor').evaluate((root) => [ ['preview','.stage-column'], ['captions','.caption-panel'], ['inspector','.workspace-inspector'] ]
    .map(([id,selector]) => ({ id, node: root.querySelector(`:scope > ${selector}`)! }))
    .filter(({ node }) => getComputedStyle(node).display !== 'none')
    .sort((a,b) => a.node.getBoundingClientRect().left - b.node.getBoundingClientRect().left).map(({ id }) => id)) as Promise<Pane[]>;
}
async function setOrder(page: Page, next: Pane[]) {
  const panel = await arrange(page);
  for (let index = 0; index < next.length; index++) {
    let visible = await actualOrder(page);
    while (visible.indexOf(next[index]) > index) {
      await panel.getByRole('button', { name: `Move ${labels[next[index]]} panel left`, exact: true }).click(); visible = await actualOrder(page);
    }
  }
  await expect.poll(() => actualOrder(page)).toEqual(next);
  await panel.getByRole('button', { name: 'Close panel arrangement', exact: true }).click();
}
async function assertTraversal(page:Page,order:Pane[]) {
  expect(await page.locator('.refined-editor').evaluate((root) => [...root.children].every((node) => getComputedStyle(node).getPropertyValue('reading-order').trim() === getComputedStyle(node).order))).toBe(true);
  const boundaries=page.locator('.editor-divider:visible');
  const focusedPane=() => page.evaluate(() => document.activeElement?.closest('.stage-column') ? 'preview' : document.activeElement?.closest('.caption-panel') ? 'captions' : document.activeElement?.closest('.workspace-inspector') ? 'inspector' : 'other');
  for(let index=0;index<order.length-1;index++) {
    await boundaries.nth(index).focus(); await expect(boundaries.nth(index)).toBeFocused(); await page.keyboard.press('Tab');
    expect(await focusedPane(),`forward ${order.join(',')}`).toBe(order[index+1]);
    await boundaries.nth(index).focus(); await page.keyboard.press('Shift+Tab');
    expect(await focusedPane(),`backward ${order.join(',')}`).toBe(order[index]);
  }
}

test('all six orders preserve mounted evidence and survive three/two/three panes without gaps', async ({ page }) => {
  await openProject(page); await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.evaluate(() => { (window as any).__paneMedia = document.querySelector('video'); (window as any).__paneCaptions = document.querySelector('.caption-panel'); });
  for (const order of orders) {
    await setOrder(page,order);
    await assertTraversal(page,order);
    const before = (await page.locator('.media-stage').boundingBox())!;
    expect(await page.evaluate(() => (window as any).__paneMedia === document.querySelector('video') && (window as any).__paneCaptions === document.querySelector('.caption-panel'))).toBe(true);
    await page.getByRole('button', { name: 'Close tool', exact: true }).click();
    await expect.poll(() => actualOrder(page)).toEqual(order.filter((pane) => pane !== 'inspector'));
    await assertTraversal(page,order.filter((pane) => pane !== 'inspector'));
    expect(Math.abs((await page.locator('.media-stage').boundingBox())!.width - before.width)).toBeLessThan(1);
    expect(await page.locator('.editor-divider:visible').count()).toBe(1);
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await expect.poll(() => actualOrder(page)).toEqual(order);
    expect(Math.abs((await page.locator('.media-stage').boundingBox())!.width - before.width)).toBeLessThan(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('two-pane movement keeps Tool position, persists after reload, and Reset restores both sizes and order', async ({ page }) => {
  await openProject(page); await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await setOrder(page,['preview','inspector','captions']);
  await page.getByRole('button', { name: 'Close tool', exact: true }).click();
  await setOrder(page,['captions','preview']);
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect.poll(() => actualOrder(page)).toEqual(['captions','inspector','preview']);
  await assertTraversal(page,['captions','inspector','preview']);
  await page.reload(); await openProject(page); await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect.poll(() => actualOrder(page)).toEqual(['captions','inspector','preview']);
  await page.getByRole('button', { name: 'Reset layout', exact: true }).click();
  await expect.poll(() => actualOrder(page)).toEqual(orders[0]);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('sthang:editor-layout:v2')!));
  expect(saved).toEqual({ preview:.36,inspector:.28,order:orders[0] });
});

test('waveform dock avoids the preview and keyboard traversal follows every visual order', async ({ page }) => {
  await openProject(page); await page.getByRole('button', { name: 'Fine timing', exact: true }).click();
  await expect(page.locator('.waveform-loading')).toHaveCount(0);
  for (const order of orders) {
    await setOrder(page,order);
    const video = (await page.locator('.stage-column').boundingBox())!;
    const dock = (await page.locator('.editor-timing-dock').boundingBox())!;
    expect(dock.x + dock.width <= video.x + 1 || dock.x >= video.x + video.width - 1).toBe(true);
    const caption = (await page.locator('.caption-panel').boundingBox())!;
    if (order[1] === 'preview') { expect(Math.abs(dock.x-caption.x)).toBeLessThan(1); expect(Math.abs(dock.width-caption.width)).toBeLessThan(1); }
    await assertTraversal(page,order);
    const canvas = page.locator('.waveform-data-canvas');
    await expect.poll(() => canvas.evaluate((node) => Math.abs(node.getBoundingClientRect().width-node.parentElement!.clientWidth))).toBeLessThan(2);
  }
  await page.setViewportSize({ width:1280,height:1000 });
  await setOrder(page,['captions','preview','inspector']);
  expect((await page.locator('.editor-timing-dock').boundingBox())!.width).toBeGreaterThanOrEqual(359);
  expect(await page.locator('.timing-edge-actions button').evaluateAll((buttons) => buttons.every((button) => button.scrollWidth <= button.clientWidth+1))).toBe(true);
});

test('adjacent Preview–Tool resizing changes both neighbors and leaves Captions fixed', async ({ page }) => {
  await openProject(page); await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await setOrder(page,['preview','inspector','captions']);
  const widths = () => page.locator('.refined-editor').evaluate((root) => ['.stage-column','.workspace-inspector','.caption-panel'].map((selector) => root.querySelector(selector)!.getBoundingClientRect().width));
  const before = await widths();
  await page.getByRole('separator', { name:'Resize Preview and Tool',exact:true }).press('ArrowRight');
  const after = await widths(); expect(after[0]-before[0]).toBe(16); expect(after[1]-before[1]).toBe(-16); expect(after[2]).toBe(before[2]);
});

test('dragging provides tactile feedback, commits once, and Escape/outside/lost capture cancel cleanly', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion:'reduce' });
  await openProject(page); await page.getByRole('button', { name:'Appearance',exact:true }).click();
  const panel = await arrange(page); const grip = panel.getByRole('button',{ name:'Drag Preview panel to reorder',exact:true });
  const source = (await grip.boundingBox())!; const destination = (await panel.getByRole('button',{ name:'Drag Tool panel to reorder',exact:true }).boundingBox())!;
  await page.screenshot({ path:info.outputPath('arrange-panels.png'),fullPage:true });
  async function begin() { await page.mouse.move(source.x+source.width/2,source.y+source.height/2); await page.mouse.down(); await page.mouse.move(destination.x+destination.width/2,destination.y+destination.height/2,{ steps:5 }); await expect(page.locator('.editor-panel-ghost')).toBeVisible(); }
  await begin(); await expect(page.locator('.editor-arrange-panel.is-drop-target')).toHaveAttribute('data-panel','inspector');
  const ghostBox=(await page.locator('.editor-panel-ghost').boundingBox())!;
  expect(ghostBox.x+ghostBox.width).toBeLessThanOrEqual(2048); expect(ghostBox.y+ghostBox.height).toBeLessThanOrEqual(1041);
  await page.screenshot({ path:info.outputPath('drag-feedback.png'),fullPage:true });
  expect(await page.locator('.editor-panel-ghost').evaluate((node) => getComputedStyle(node).transform)).toBe('none');
  await page.keyboard.press('Escape'); await page.mouse.up(); await expect.poll(() => actualOrder(page)).toEqual(orders[0]);
  await expect(page.locator('.workspace-inspector')).toBeVisible();
  await begin(); await page.mouse.move(10,800); await page.mouse.up(); await expect.poll(() => actualOrder(page)).toEqual(orders[0]);
  await begin(); await grip.evaluate((node) => node.releasePointerCapture(1)); await page.mouse.up(); await expect.poll(() => actualOrder(page)).toEqual(orders[0]);
  await begin(); await page.mouse.up(); await expect.poll(() => actualOrder(page)).toEqual(['captions','inspector','preview']);
  await expect(page.locator('.editor-panel-ghost')).toHaveCount(0);
  await panel.getByRole('button',{ name:'Close panel arrangement',exact:true }).click();
  await page.screenshot({ path:info.outputPath('preview-right.png'),fullPage:true });
});

test('breakpoint changes cancel captured gestures and returning to desktop restores the last committed order', async ({ page }) => {
  await openProject(page); await page.getByRole('button',{ name:'Appearance',exact:true }).click(); await setOrder(page,['captions','inspector','preview']);
  const panel = await arrange(page); const grip = (await panel.getByRole('button',{ name:'Drag Preview panel to reorder',exact:true }).boundingBox())!;
  await page.mouse.move(grip.x+20,grip.y+20); await page.mouse.down(); await page.mouse.move(grip.x-80,grip.y+20);
  await page.setViewportSize({ width:1100,height:900 }); await page.mouse.up();
  await expect(panel).toBeHidden(); await expect(page.locator('.editor-panel-ghost')).toHaveCount(0);
  await expect(page.locator('.editor-layout-controls')).toBeHidden();
  await page.setViewportSize({ width:2048,height:1041 }); await expect.poll(() => actualOrder(page)).toEqual(['captions','inspector','preview']);
  const separator = page.locator('.editor-divider:visible').first(); const box = (await separator.boundingBox())!;
  const saved = await page.evaluate(() => localStorage.getItem('sthang:editor-layout:v2'));
  await page.mouse.move(box.x+4,box.y+20); await page.mouse.down(); await page.mouse.move(box.x+60,box.y+20);
  await page.keyboard.press('Escape'); await page.mouse.up();
  expect(await page.evaluate(() => localStorage.getItem('sthang:editor-layout:v2'))).toBe(saved);
});

test('layout keyboard shortcuts and a geometry change during timing drag never alter caption times', async ({ page }) => {
  await openProject(page); await page.getByRole('button',{ name:'Fine timing',exact:true }).click(); await expect(page.locator('.waveform-loading')).toHaveCount(0);
  const before = structuredClone(state.projects[0].captions);
  const panel = await arrange(page); const grip = panel.getByRole('button',{ name:'Drag Preview panel to reorder',exact:true });
  await grip.focus(); await page.keyboard.press('Alt+ArrowRight'); await page.keyboard.press('Control+z'); await page.keyboard.press('r');
  expect(state.projects[0].captions).toEqual(before); expect(await page.locator('video').evaluate((node:HTMLVideoElement) => node.paused)).toBe(true);
  await grip.press('ArrowRight'); await expect.poll(() => actualOrder(page)).toEqual(['captions','preview','inspector']); await expect(grip).toBeFocused();
  await page.keyboard.press('Escape'); await expect(panel).toBeHidden(); await expect(page.locator('.fine-timing')).toBeVisible();
  const canvas = (await page.locator('.waveform-data-canvas').boundingBox())!;
  await page.mouse.move(canvas.x+canvas.width*.15,canvas.y+155); await page.mouse.down();
  await expect(page.locator('.waveform-canvas-wrap')).toHaveClass(/dragging/);
  await page.getByRole('button',{ name:'Arrange panels',exact:true }).focus(); await page.keyboard.press('Enter');
  await panel.getByRole('button',{ name:'Preview right',exact:true }).focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.waveform-canvas-wrap')).not.toHaveClass(/dragging/);
  await page.mouse.move(canvas.x+canvas.width*.3,canvas.y+155); await page.mouse.up();
  expect(state.projects[0].captions).toEqual(before);
});

test('reordering keeps a playing video alive and preserves caption text/selection without remounting', async ({ page }) => {
  await openProject(page); await page.getByRole('button',{ name:'Appearance',exact:true }).click();
  const text = page.getByLabel('Caption 2 text',{ exact:true }); await text.fill('Unfinished caption wording');
  await text.evaluate((node:HTMLTextAreaElement) => node.setSelectionRange(3,9));
  await page.locator('video').evaluate(async (node:HTMLVideoElement) => { node.loop=true; (window as any).__playingPaneVideo=node; (window as any).__unexpectedPauses=0; node.addEventListener('pause',() => (window as any).__unexpectedPauses++); await node.play(); });
  for (const next of [orders[2],orders[4],orders[0]]) {
    await setOrder(page,next);
    expect(await page.locator('video').evaluate((node:HTMLVideoElement) => node === (window as any).__playingPaneVideo && !node.paused && node.readyState >= 2)).toBe(true);
  }
  expect(await page.evaluate(() => (window as any).__unexpectedPauses)).toBe(0);
  await expect(text).toHaveValue('Unfinished caption wording');
  expect(await text.evaluate((node:HTMLTextAreaElement) => [node.selectionStart,node.selectionEnd])).toEqual([3,9]);
});

test('unsupported reading-flow keeps a truthful canonical order while retaining the saved preference', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sthang:editor-layout:v2',JSON.stringify({ preview:.36,inspector:.28,order:['captions','inspector','preview'] }));
    const supports = CSS.supports.bind(CSS); CSS.supports = ((...args:string[]) => args[0] === 'reading-flow' ? false : (supports as any)(...args)) as typeof CSS.supports;
  });
  await openProject(page); await page.getByRole('button',{ name:'Appearance',exact:true }).click();
  await expect.poll(() => actualOrder(page)).toEqual(orders[0]); await expect(page.getByRole('button',{ name:'Arrange panels',exact:true })).toBeDisabled();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('sthang:editor-layout:v2')!).order)).toEqual(['captions','inspector','preview']);
});

test('two-finger touch cancellation cannot commit a second conflicting gesture', async ({ page }) => {
  await openProject(page); await page.getByRole('button',{ name:'Appearance',exact:true }).click();
  const panel=await arrange(page);
  const first=(await panel.getByRole('button',{ name:'Drag Preview panel to reorder',exact:true }).boundingBox())!;
  const last=(await panel.getByRole('button',{ name:'Drag Tool panel to reorder',exact:true }).boundingBox())!;
  const cdp=await page.context().newCDPSession(page);
  const start={ x:first.x+first.width/2,y:first.y+first.height/2,id:1 };
  const destination={ x:last.x+last.width/2,y:last.y+last.height/2,id:1 };
  await cdp.send('Input.dispatchTouchEvent',{ type:'touchStart',touchPoints:[start] });
  await cdp.send('Input.dispatchTouchEvent',{ type:'touchMove',touchPoints:[destination] });
  await expect(page.locator('.editor-panel-ghost')).toBeVisible();
  await cdp.send('Input.dispatchTouchEvent',{ type:'touchStart',touchPoints:[destination,{ ...start,id:2 }] });
  await cdp.send('Input.dispatchTouchEvent',{ type:'touchCancel',touchPoints:[] });
  await expect(page.locator('.editor-panel-ghost')).toHaveCount(0); await expect.poll(() => actualOrder(page)).toEqual(orders[0]);
  await cdp.detach();
});

for (const missing of ['reading-order','popover']) test(`missing ${missing} leaves resizing usable and arrangement hidden`,async ({ page }) => {
  await page.addInitScript((missing) => {
    if(missing === 'popover') Object.defineProperty(HTMLElement.prototype,'showPopover',{ configurable:true,value:undefined });
    else { const supports=CSS.supports.bind(CSS); CSS.supports=((...args:string[]) => args[0] === 'reading-order' ? false : (supports as any)(...args)) as typeof CSS.supports; }
  },missing);
  await openProject(page); await page.getByRole('button',{ name:'Appearance',exact:true }).click();
  await expect(page.getByRole('button',{ name:'Arrange panels',exact:true })).toBeDisabled();
  await expect(page.getByRole('region',{ name:'Arrange panels',exact:true })).toBeHidden();
  await page.getByRole('separator',{ name:'Resize Preview and Captions',exact:true }).press('ArrowRight');
  await expect.poll(() => actualOrder(page)).toEqual(orders[0]);
});
