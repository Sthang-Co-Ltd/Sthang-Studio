import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import type { CaptionProject } from '@kcs/shared';
import { km } from '../../apps/web/src/i18n/messages/km/index.js';
import { catalogValues, khmerKeyboardTokens, pendingEnglishValues } from '../khmer-catalog-coverage.js';

const latinWords = /\p{Script=Latin}{3,}/gu;

export async function openKhmerTool(page: Page, name: string) {
  await page.locator('[data-project-tools-trigger]').click();
  await page.getByRole('menuitem').filter({ has: page.getByText(name, { exact: true }) }).click();
}

export async function revealDetails(details: Locator) {
  if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
}

function approvedWords(projects: CaptionProject[], fixtureContent: string[]) {
  const content = projects.flatMap(({ title, media, captions }) =>
    [title, media.filename, media.originalName, ...captions.map(({ text }) => text)]);
  const words = (values: string[]) => [...new Set(values.flatMap((value) => value.match(latinWords) ?? []))].sort();
  return {
    // Markup and placeholder names do not appear in the rendered copy.
    catalog: words(catalogValues(km).map((value) => value.replace(/<\/?(?:b|code)>|\{[a-zA-Z][a-zA-Z0-9_]*\}/g, ' '))),
    content: words([...content, ...fixtureContent]), // Fixture-only project titles, filenames and captions.
    brand: ['Sthang', 'Studio', 'STHANG', 'STUDIO'], // Approved identity.
  };
}

export async function captureKhmerLayout(page: Page, surface: string, regions: string, projects: CaptionProject[], options: {
  evidence: string;
  phase: 'A' | 'B' | 'C';
  fixtureContent?: string[];
}) {
  const size = page.viewportSize()!;
  const folder = path.join(options.evidence, `${size.width}x${size.height}`);
  await mkdir(folder, { recursive: true });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const approved = approvedWords(projects, options.fixtureContent ?? []);
  const pendingEnglish = [...pendingEnglishValues()];
  const result = await page.evaluate(({ regions, approved, pendingEnglish, latinPattern, keyboardTokens, phase }) => {
    // The literal native language names are part of the bilingual switch contract.
    const exempt = '.interface-language-switch button[lang="en"], .interface-language-switch button[lang="km"], [data-server-text]';
    const allow = new Set(Object.values(approved).flat());
    const keys = new Set<string>(keyboardTokens);
    const arrowWords = new Set(['Left', 'Right', 'Up', 'Down']);
    const pending = new Set(pendingEnglish);
    const shortKeys = keyboardTokens.filter((key) => key.length < 3).join('|');
    const wordCharacter = '[\\p{Script=Latin}\\p{N}_]';
    const words = new RegExp(`${latinPattern}|(?<!${wordCharacter})(?:Up|${shortKeys})(?!${wordCharacter})`, 'gu');
    const phaseBControls = ', h5, h6, .export-source-chip, .export-check-title > span, .regen-title-copy > span, .decision-label, .project-state';
    const phaseCControls = ', strong, legend, select, .toast > span, .privacy-upgrade-kicker, .privacy-status-chip, ' +
      '.job-state, .regen-candidates article > div > span, .native-preview-status > span, .source-media-status > span, ' +
      '.review-focus-label, .copy-report-recovery > span, .guide-shortcuts kbd';
    const controls = 'button, summary, a[href], [role="menuitem"], label, h1, h2, h3, h4, ' +
      '.risk-reasons > span, .caption-state-line > span, .first-run-step-header > small, ' +
      '.generation-accuracy-copy small, .workspace-tools-popover em, .stage-rail .tool-badge' +
      (phase === 'A' ? '' : phaseBControls) + (phase === 'C' ? phaseCControls : '');
    const visible = (element: Element) => element.checkVisibility({ visibilityProperty: true }) && element.getClientRects().length > 0;
    const describe = (element: Element) => `${element.tagName.toLowerCase()}${Array.from(element.classList).map((name) => `.${name}`).join('')}`;
    const checked = new Set<Element>();
    const observedText = new Set<Node>();
    const elements = [];
    const captionFields = [];
    const untranslated = [];
    const pendingText = new Set<string>();
    const compactText = [];
    const checkedRegions = [];
    for (const region of document.querySelectorAll(regions)) {
      if (!visible(region)) continue;
      checkedRegions.push(describe(region));
      for (const field of region.querySelectorAll('.caption-text-cell textarea')) {
        if (!visible(field)) continue;
        const rect = field.getBoundingClientRect();
        const cell = field.parentElement!.getBoundingClientRect();
        captionFields.push({ label: field.getAttribute('aria-label'), width: rect.width, cellWidth: cell.width, right: rect.right, cellRight: cell.right });
      }
      for (const element of [region, ...region.querySelectorAll(controls)]) {
        if (!element.matches(controls) || element.matches('.sr-only') || checked.has(element) || !visible(element)) continue;
        checked.add(element);
        const rect = element.getBoundingClientRect();
        const css = getComputedStyle(element);
        elements.push({ element: describe(element), label: element.getAttribute('aria-label') || element.textContent?.trim(),
          target: element.matches('button, summary, a[href], [role="menuitem"]') || phase === 'C' && element.matches('select'),
          width: rect.width, height: rect.height, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
          fontSize: parseFloat(css.fontSize),
          clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, overflowX: css.overflowX,
          clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, overflowY: css.overflowY });
      }
      const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const parent = node.parentElement;
        const value = node.textContent?.trim();
        if (!value || !parent || observedText.has(node) || parent.closest(exempt) || !visible(parent)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        if (!range.getClientRects().length) continue;
        observedText.add(node);
        if (phase !== 'A' && /\p{Script=Khmer}/u.test(value)) {
          const fontSize = Number.parseFloat(getComputedStyle(parent).fontSize);
          if (fontSize < 14) compactText.push({ element: describe(parent), container: parent.parentElement && describe(parent.parentElement), fontSize });
        }
        if (pending.has(value)) {
          pendingText.add(value);
          continue;
        }
        const unknown = [...new Set([...value.matchAll(words)].flatMap(({ 0: word, index }) => {
          if (arrowWords.has(word)) return [word];
          if (keys.has(word)) {
            const adjoining = value.charAt(index - 1) + value.charAt(index + word.length);
            return /[\p{N}_]/u.test(adjoining) ? [word] : [];
          }
          return allow.has(word) ? [] : [word];
        }))];
        if (unknown.length) untranslated.push({ element: describe(parent), text: value, words: unknown });
      }
    }
    return { pageWidth: innerWidth, pageScrollWidth: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth),
      checkedRegions, elements, captionFields, pendingText: [...pendingText].sort(), compactText, untranslated };
  }, { regions, approved, pendingEnglish, latinPattern: latinWords.source, keyboardTokens: khmerKeyboardTokens, phase: options.phase });
  await writeFile(path.join(folder, `${surface}.json`), JSON.stringify({ ...result, approved }, null, 2));
  await page.screenshot({ path: path.join(folder, `${surface}.png`), animations: 'disabled', fullPage: surface.startsWith('home-') });
  expect.soft(result.checkedRegions.length, `${surface}: Phase ${options.phase} regions present`).toBeGreaterThan(0);
  expect.soft(result.pageScrollWidth, `${surface}: horizontal page scroll`).toBeLessThanOrEqual(result.pageWidth);
  const clipped = result.elements.filter(({ target, clientWidth, scrollWidth, clientHeight, scrollHeight, overflowX, overflowY }) =>
    ((target || overflowX !== 'visible') && scrollWidth > clientWidth + 1)
    || ((target || overflowY !== 'visible') && scrollHeight > clientHeight + 1));
  expect.soft(clipped, `${surface}: clipped controls and labels`).toEqual([]);
  expect.soft(result.captionFields.filter(({ right, cellRight }) => right > cellRight + 1),
    `${surface}: caption fields extending into row actions`).toEqual([]);
  if (size.width === 390) {
    expect.soft(result.elements.filter(({ target, width, height }) => target && (width < 44 || height < 44)),
      `${surface}: targets under 44px`).toEqual([]);
  }
  if (options.phase !== 'A') {
    expect.soft(result.compactText.filter(({ fontSize }) => fontSize < 12), `${surface}: text below the Khmer minimum`).toEqual([]);
  }
  if (options.phase === 'C') {
    const smallControls = result.elements.filter(({ target, label, fontSize }) =>
      target && label && /\p{Script=Khmer}/u.test(label) && fontSize < 14);
    expect.soft(smallControls, `${surface}: Khmer controls below 14px`).toEqual([]);
  }
  expect.soft(result.untranslated, `${surface}: untranslated text`).toEqual([]);
}
