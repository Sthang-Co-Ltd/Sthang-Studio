import type { CaptionSegment } from '@kcs/shared';

export type MatchMode = 'literal' | 'case-insensitive' | 'regex';

/** One plan supplies both the displayed proposal and the applied edit. */
export function planReplacement(captions: CaptionSegment[], query: string, replacement: string, mode: MatchMode, targetIds: Set<string> | null = null) {
  const entries: Array<{ caption: CaptionSegment; after: string; changed: boolean }> = [];
  let count = 0;
  let locked = 0;
  let changed = 0;
  if (!query) return { entries, count, locked, changed, error: '' };
  let regex: RegExp;
  try {
    const pattern = mode === 'regex' ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    regex = new RegExp(pattern, mode === 'case-insensitive' ? 'giu' : 'gu');
  } catch {
    return { entries, count, locked, changed, error: 'Invalid regular expression. Check the Find pattern.' };
  }
  for (const caption of captions) {
    if (targetIds && !targetIds.has(caption.id)) continue;
    regex.lastIndex = 0;
    const hits = [...caption.text.matchAll(regex)].length;
    if (!hits) continue;
    count += hits;
    if (caption.textLocked) locked += hits;
    regex.lastIndex = 0;
    const after = caption.textLocked ? caption.text : caption.text.replace(regex, replacement);
    const isChanged = after !== caption.text;
    if (isChanged) changed++;
    entries.push({ caption, after, changed: isChanged });
  }
  return { entries, count, locked, changed, error: '' };
}

export function applyReplacementPlan(captions: CaptionSegment[], plan: ReturnType<typeof planReplacement>): CaptionSegment[] {
  const edits = new Map(plan.entries.filter((entry) => entry.changed).map((entry) => [entry.caption, entry.after]));
  return captions.map((caption) => edits.has(caption) ? { ...caption, text: edits.get(caption)!, approved: false } : caption);
}
