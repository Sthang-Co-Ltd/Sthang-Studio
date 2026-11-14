/** Recognize an exported profile's core envelope before a full replacement.
 * Entry values and newer optional fields still belong to server normalization. */
export function isProfileImport(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return raw.version === 1
    && Array.isArray(raw.defaultVocabulary)
    && raw.defaultVocabulary.every((line: unknown) => typeof line === 'string')
    && [raw.styles, raw.topicPacks, raw.correctionRules, raw.correctionEvents].every(Array.isArray)
    && Boolean(raw.preferences && typeof raw.preferences === 'object' && !Array.isArray(raw.preferences))
    && typeof raw.updatedAt === 'string' && raw.updatedAt.trim().length > 0;
}
