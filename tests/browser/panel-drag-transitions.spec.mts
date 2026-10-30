import { test, expect, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures } from './fixtures.mjs';

type Pane = 'preview' | 'captions' | 'inspector';
const selectors = { preview:'.stage-column', captions:'.caption-panel', inspector:'.workspace-inspector' };
const orders:Pane[][] = [['preview','captions','inspector'],['preview','inspector','captions'],['captions','preview','inspector'],['inspector','preview','captions'],['captions','inspector','preview'],['inspector','captions','preview']];
let errors:string[];
test.beforeAll(prepareFixtures); test.afterAll(cleanFixtures);
test.beforeEach(async ({ page }) => {
  errors=[]; page.on('pageerror',(error) => errors.push(error.message));
  await installFixture(page); await page.setViewportSize({ width:2048,height:1041 });
});
test.afterEach(() => expect(errors).toEqual([]));
const pane = (page:Page,id:Pane) => page.locator(`.refined-editor > ${selectors[id]}`);
const grip = (page:Page,id:Pane) => pane(page,id).getByRole('button',{ name:/^Drag .+ panel header to reorder$/ });
const saved = (page:Page) => page.evaluate(() => localStorage.getItem('sthang:editor-layout:v2'));
async function setup(page:Page,order:Pane[]) {
  await page.addInitScript((order) => localStorage.setItem('sthang:editor-layout:v2',JSON.stringify({ preview:.36,inspector:.28,order })),order);
  await openProject(page); await page.getByRole('button',{ name:'Appearance',exact:true }).click();
  await page.evaluate(() => { (window as any).__transitionVideo=document.querySelector('video'); (window as any).__transitionList=document.querySelector('.caption-list'); });
}
async function begin(page:Page,source:Pane,target:Pane) {
  const header=(await grip(page,source).boundingBox())!;
  const destination=(await pane(page,target).boundingBox())!;
  const sourceBox=(await pane(page,source).boundingBox())!;
  const x=destination.x+destination.width/2+(sourceBox.x<destination.x ? 2 : -2);
  const y=destination.y+100;
  await page.mouse.move(header.x+header.width/2,header.y+header.height/2);
  await page.mouse.down(); await page.mouse.move(x,y,{ steps:4 });
  await expect(page.locator('.editor-pane-floating')).toHaveCount(1);
}
async function keyActivate(page:Page,name:string) {
  await page.getByRole('button',{ name,exact:true }).evaluate((node:HTMLButtonElement) => node.focus({ preventScroll:true }));
  await page.keyboard.press('Enter');
}
async function assertClean(page:Page,order:Pane[]) {
  await expect(page.locator('.editor-pane-floating,.editor-pane-shifting,.editor-pane-settling,.editor-pane-landing,.editor-pane-held')).toHaveCount(0);
  await expect(page.locator('.editor-panel-placeholder')).toBeHidden();
  const result=await page.locator('.refined-editor').evaluate((root) => {
    const nodes=[...root.querySelectorAll<HTMLElement>(':scope > .stage-column,:scope > .caption-panel,:scope > .workspace-inspector')];
    const bounds=nodes.filter((node) => getComputedStyle(node).display!=='none').map((node) => ({
      id:node.matches('.stage-column') ? 'preview' : node.matches('.caption-panel') ? 'captions' : 'inspector', rect:node.getBoundingClientRect(),
    })).sort((a,b) => a.rect.left-b.rect.left);
    const rect=root.getBoundingClientRect();
    return {
      order:bounds.map(({ id }) => id),
      contiguous:bounds.every(({ rect },index) => index===0 || Math.abs(rect.left-bounds[index-1].rect.right-8)<1),
      contained:Math.abs(bounds[0].rect.left-rect.left)<1 && Math.abs(bounds.at(-1)!.rect.right-rect.right)<1,
      transformsCleared:nodes.every((node) => !node.style.transform && getComputedStyle(node).transform==='none'),
      draftCleared:!root.hasAttribute('data-header-drag-order') && !root.hasAttribute('data-header-drop-valid') && !root.classList.contains('is-header-dragging') && !(['left','top','width','height'].some((name) => (root as HTMLElement).style.getPropertyValue(`--editor-drop-${name}`))),
    };
  });
  expect(result).toEqual({ order,contiguous:true,contained:true,transformsCleared:true,draftCleared:true });
  expect(await page.evaluate(() => (window as any).__transitionVideo===document.querySelector('video') && (window as any).__transitionList===document.querySelector('.caption-list'))).toBe(true);
}

for(const order of orders) test(`all drag sources survive 3/2/3 transitions with saved order ${order.join('/')}`,async ({ page }) => {
  await setup(page,order); const original=await saved(page); const previewWidth=(await pane(page,'preview').boundingBox())!.width;
  for(const source of order) {
    await begin(page,source,order.find((id) => id!==source)!);
    await keyActivate(page,'Close tool'); await page.mouse.up();
    await assertClean(page,order.filter((id) => id!=='inspector')); expect(await saved(page)).toBe(original);
    expect((await pane(page,'preview').boundingBox())!.width).toBe(previewWidth);
    await page.getByRole('button',{ name:'Appearance',exact:true }).click(); await assertClean(page,order);
  }
  for(const source of ['preview','captions'] as Pane[]) {
    await page.getByRole('button',{ name:'Close tool',exact:true }).click();
    await begin(page,source,source==='preview' ? 'captions' : 'preview');
    await keyActivate(page,'Appearance'); await page.mouse.up();
    await assertClean(page,order); expect(await saved(page)).toBe(original);
    expect((await pane(page,'preview').boundingBox())!.width).toBe(previewWidth);
  }
  await page.getByRole('button',{ name:'Close tool',exact:true }).click();
  await begin(page,'preview','captions'); await page.mouse.up();
  const swapped=order.map((id) => id==='preview' ? 'captions' : id==='captions' ? 'preview' : id) as Pane[];
  await assertClean(page,swapped.filter((id) => id!=='inspector'));
  await page.getByRole('button',{ name:'Appearance',exact:true }).click(); await assertClean(page,swapped);
});

for(const panels of [2,3]) for(const phase of ['landing','cancel']) for(const action of ['drag','click','toggle']) test(`${panels} panels: regrab during ${phase}, then ${action}, retains anchor and state`,async ({ page }) => {
  await setup(page,orders[0]);
  if(panels===2) await page.getByRole('button',{ name:'Close tool',exact:true }).click();
  await begin(page,'preview',panels===2 ? 'captions' : 'inspector');
  if(phase==='landing') await page.mouse.up();
  else { await page.keyboard.press('Escape'); await page.mouse.up(); }
  const paused=await pane(page,'preview').evaluate((node) => {
    const animations=node.getAnimations();
    for(const animation of animations) { animation.pause(); animation.currentTime=45; }
    return animations.length;
  });
  expect(paused).toBeGreaterThan(0);
  const original=await saved(page); const before=(await grip(page,'preview').boundingBox())!;
  const x=before.x+before.width/2; const y=before.y+before.height/2;
  await page.mouse.move(x,y); await page.mouse.down();
  const grabbed=(await grip(page,'preview').boundingBox())!;
  expect(grabbed.x,'pointerdown must not snap a moving header').toBeCloseTo(before.x,0);
  expect(grabbed.y).toBeCloseTo(before.y,0);
  if(action==='drag') {
    await page.mouse.move(x+18,y+14);
    const moved=(await grip(page,'preview').boundingBox())!;
    expect(moved.x-before.x).toBeCloseTo(18,0); expect(moved.y-before.y).toBeCloseTo(14,0);
    await page.keyboard.press('Escape');
  } else if(action==='toggle') await keyActivate(page,panels===2 ? 'Appearance' : 'Close tool');
  await page.mouse.up();
  const full:Pane[]=phase==='landing' ? panels===2 ? ['captions','preview','inspector'] : ['captions','inspector','preview'] : orders[0];
  const open=action==='toggle' ? panels===2 : panels===3;
  await assertClean(page,full.filter((id) => open || id!=='inspector'));
  expect(await saved(page)).toBe(original);
  if(!open) { await page.getByRole('button',{ name:'Appearance',exact:true }).click(); await assertClean(page,full); }
});

test('an inspector regrab preserves its fractional anchor while its height is settling',async ({ page },info) => {
  await setup(page,orders[0]); await page.getByRole('button',{ name:'Fine timing',exact:true }).click();
  await expect(page.locator('.waveform-loading')).toHaveCount(0);
  await begin(page,'inspector','preview'); await page.mouse.up();
  const paused=await pane(page,'inspector').evaluate((node) => {
    const animations=node.getAnimations();
    for(const animation of animations) { animation.pause(); animation.currentTime=45; }
    return animations.length;
  });
  expect(paused).toBeGreaterThan(0);
  const original=await saved(page); const before=(await grip(page,'inspector').boundingBox())!;
  const fraction={ x:.3,y:.65 }; const x=before.x+before.width*fraction.x; const y=before.y+before.height*fraction.y;
  await page.mouse.move(x,y); await page.mouse.down();
  const held=(await grip(page,'inspector').boundingBox())!;
  expect(Math.abs(held.height-before.height)).toBeGreaterThan(.2);
  expect(held.x+held.width*fraction.x).toBeCloseTo(x,0); expect(held.y+held.height*fraction.y).toBeCloseTo(y,0);
  await page.mouse.move(x+18,y+14);
  const moved=(await grip(page,'inspector').boundingBox())!;
  expect(moved.x+moved.width*fraction.x).toBeCloseTo(x+18,0); expect(moved.y+moved.height*fraction.y).toBeCloseTo(y+14,0);
  await page.screenshot({ path:info.outputPath('interrupted-inspector-grab.png'),fullPage:true });
  await page.keyboard.press('Escape'); await page.mouse.up(); await assertClean(page,['inspector','preview','captions']);
  expect(await saved(page)).toBe(original);
  await page.getByRole('button',{ name:'Close tool',exact:true }).click(); await assertClean(page,['preview','captions']);
  await page.getByRole('button',{ name:'Fine timing',exact:true }).click(); await assertClean(page,['inspector','preview','captions']);
});
