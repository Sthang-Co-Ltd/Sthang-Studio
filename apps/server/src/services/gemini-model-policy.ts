/**
 * Google announced on 2026-10-08 that Gemini 3.7 Flash requests now run on
 * 3.8 Flash, and Gemini 3.5 Flash requests now run on 3.6 Flash.
 *
 * Keep this map limited to those officially documented exact model aliases.
 * Other model IDs may be deliberate user selections and must stay intact.
 * https://ai.google.dev/gemini-api/docs/changelog
 */
export const defaultGeminiModel = 'gemini-3.8-flash';
export const defaultGeminiFallbackModel = 'gemini-3.6-flash';

function modelId(value: string): string {
  return value.trim().replace(/^models\//, '');
}

export function canonicalGeminiModel(model: string): string {
  const id = modelId(model);
  if (id === 'gemini-3.7-flash') return 'gemini-3.8-flash';
  if (id === 'gemini-3.5-flash') return 'gemini-3.6-flash';
  return id;
}

export function dedicatedTranscriptionModel(model: string): boolean {
  return /^gemini-3\.5-transcribe(?:$|-)/i.test(canonicalGeminiModel(model));
}

/**
 * The effective Interactions request policy for context-aware caption listens.
 * Keep this independent of obsolete local thinking-level environment overrides.
 * Unknown model IDs retain their provider-defined request behavior.
 */
export function geminiTranscriptionGenerationConfig(model: string): { thinking_level: 'low' } | undefined {
  const id = canonicalGeminiModel(model);
  if (dedicatedTranscriptionModel(id)) return undefined; // Separate verbatim transcription API shape.
  return /^gemini-(?:3(?:\.|-|$)|2\.5(?:-|$))/i.test(id) || id === 'gemini-4-hydrogen'
    ? { thinking_level: 'low' }
    : undefined;
}

export function resolveGeminiModelPair(model: string, fallbackModel: string): { model: string; fallbackModel: string } {
  const requestedModel = modelId(model);
  const requestedFallback = modelId(fallbackModel);

  // These exact pairs were shipped as Studio defaults. Google now routes the
  // old 3.7 fallback to 3.8, so migrate both generations to independent models.
  const historicalDefaults =
    (requestedModel === 'gemini-3.7-flash' && requestedFallback === 'gemini-3.6-flash')
    || (requestedModel === 'gemini-3.8-flash' && requestedFallback === 'gemini-3.7-flash');
  if (historicalDefaults) {
    return { model: defaultGeminiModel, fallbackModel: defaultGeminiFallbackModel };
  }

  const resolvedModel = canonicalGeminiModel(requestedModel);
  const resolvedFallback = canonicalGeminiModel(requestedFallback);
  return {
    model: resolvedModel,
    fallbackModel: resolvedFallback && resolvedFallback !== resolvedModel ? resolvedFallback : '',
  };
}
