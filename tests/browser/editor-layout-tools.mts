import { expect, type Page } from '@playwright/test';

export const toolsButton = (page: Page) => page.getByLabel('Open project tools', { exact: true });

export async function openLayoutTools(page: Page, keyboard = false) {
  const menu = page.getByRole('menu', { name: 'Project tools', exact: true });
  if (!await menu.isVisible()) {
    if (keyboard) await toolsButton(page).press('ArrowDown');
    else await toolsButton(page).click();
  }
  await expect(menu).toBeVisible();
  return menu;
}

export async function openPanelArrangement(page: Page, keyboard = false) {
  const panel = page.getByRole('region', { name: 'Arrange panels', exact: true });
  if (!await panel.isVisible()) {
    const menu = await openLayoutTools(page, keyboard);
    const item = menu.getByRole('menuitem', { name: /^Arrange panels/ });
    if (keyboard) await item.press('Enter');
    else await item.click();
  }
  await expect(panel).toBeVisible();
  return panel;
}

export async function resetEditorLayout(page: Page, keyboard = false) {
  const panel = await openPanelArrangement(page, keyboard);
  const item = panel.getByRole('button', { name: 'Reset layout', exact: true });
  if (keyboard) await item.press('Enter');
  else await item.click();
  return panel;
}
