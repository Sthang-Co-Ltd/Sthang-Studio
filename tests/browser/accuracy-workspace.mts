import { expect, type Page } from '@playwright/test';

export async function openAccuracy(page: Page) {
  const workspace = page.getByRole('complementary', { name: 'Accuracy workspace', exact: true });
  if (!(await workspace.isVisible())) {
    const inline = page.getByRole('complementary', { name: 'Generate captions workspace', exact: true })
      .getByRole('button', { name: /^(Add|Edit) context$/ });
    const toolbar = page.getByRole('navigation', { name: 'Caption workspace tools', exact: true })
      .getByRole('button', { name: /^Accuracy\b/, pressed: false });
    await inline.or(toolbar).click();
  }
  await expect(workspace).toBeVisible();
  return {
    description: workspace.getByLabel('What is this clip about?', { exact: true }),
    vocabulary: workspace.getByLabel('Exact terms to preserve', { exact: true }),
  };
}
