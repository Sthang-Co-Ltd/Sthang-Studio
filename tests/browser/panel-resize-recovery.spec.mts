import { test, expect } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures } from './fixtures.mjs';

test.beforeAll(prepareFixtures); test.afterAll(cleanFixtures);
test.beforeEach(async ({ page }) => {
  await installFixture(page);
  await page.setViewportSize({ width:900,height:900 });
  await page.addInitScript(() => {
    // Reproduce the live browser's missing observer deliveries without replacing
    // browser input, media queries, layout, or window resize events.
    window.ResizeObserver=class { observe() {} unobserve() {} disconnect() {} } as typeof ResizeObserver;
    localStorage.setItem('sthang:editor-layout:v2',JSON.stringify({ preview:320/1040,inspector:360/1040,order:['preview','captions','inspector'] }));
  });
});

for(const open of [false,true]) test(`${open ? 'three' : 'two'} panels recover horizontal dragging after a narrow-to-desktop transition with silent observers`,async ({ page }) => {
  const errors:string[]=[]; page.on('pageerror',(error)=>errors.push(error.message));
  await openProject(page);
  if(open) await page.getByRole('button',{ name:'Appearance',exact:true }).click();
  await page.setViewportSize({ width:1262,height:1041 });
  const divider=page.getByRole('separator',{ name:'Resize Preview and Captions',exact:true });
  await expect(divider).toBeVisible();
  const initial=(await page.locator('.stage-column').boundingBox())!.width;
  const available=await divider.evaluate((node)=>Number(node.getAttribute('aria-valuemax'))-Number(node.getAttribute('aria-valuenow')));
  expect(available,'a wider desktop must expose real resize room').toBeGreaterThan(20);
  const box=(await divider.boundingBox())!;
  await page.mouse.move(box.x+box.width/2,box.y+80); await page.mouse.down(); await page.mouse.move(box.x+box.width/2+32,box.y+80,{ steps:4 }); await page.mouse.up();
  await expect.poll(async () => (await page.locator('.stage-column').boundingBox())!.width).toBeGreaterThan(initial+20);
  const grown=(await page.locator('.stage-column').boundingBox())!.width;
  await divider.press('ArrowLeft');
  await expect.poll(async () => (await page.locator('.stage-column').boundingBox())!.width).toBeLessThan(grown-10);
  const preference=await page.evaluate(()=>JSON.parse(localStorage.getItem('sthang:editor-layout:v2')!));
  expect(Object.keys(preference).sort()).toEqual(['inspector','order','preview']);
  expect(errors).toEqual([]);
});
