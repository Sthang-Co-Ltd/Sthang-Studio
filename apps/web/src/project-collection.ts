import type { CaptionProjectSummary } from '@kcs/shared';

/** Keep the actual immutable summary objects that existed when a read began.
 * Replacing even an identical summary is a newer local publication, not permission
 * for the pending read to replace it. The caller owns read-generation ordering. */
export function captureProjectCollectionBasis(items: readonly CaptionProjectSummary[]): ReadonlyMap<string, CaptionProjectSummary> {
  return new Map(items.map((item) => [item.id, item]));
}

/** Adopt the current server collection without undoing publications made while
 * it was loading. This owns metadata only, never active caption or media state. */
export function reconcileProjectCollection(
  current: readonly CaptionProjectSummary[],
  incoming: readonly CaptionProjectSummary[],
  basis: ReadonlyMap<string, CaptionProjectSummary>,
): CaptionProjectSummary[] {
  const local = current.filter((item) => basis.get(item.id) !== item);
  const seen = new Set<string>();
  const result: CaptionProjectSummary[] = [];
  for (const item of [...local, ...incoming]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}
