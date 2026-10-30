import type { CaptionGenerationModel } from '@kcs/shared';
import { resolveGeminiSettings } from './llm-settings.js';
import { currentProcessingRun } from './run-context.js';

export interface GenerationModelPair { model: string; fallbackModel: string }

export function isCaptionGenerationModel(value: unknown): value is CaptionGenerationModel {
  return value === 'automatic' || value === 'gemini-3.8-flash' || value === 'gemini-3.6-flash';
}

export function generationModelPair(choice: CaptionGenerationModel | undefined, defaults: GenerationModelPair): GenerationModelPair {
  return !choice || choice === 'automatic'
    ? { model: defaults.model, fallbackModel: defaults.fallbackModel }
    : { model: choice, fallbackModel: '' };
}

/** Only model IDs are snapshotted. Credentials are resolved normally, never persisted in jobs. */
export async function resolveGenerationSettings(choice?: CaptionGenerationModel) {
  const settings = await resolveGeminiSettings();
  const models = currentProcessingRun()?.geminiModels ?? generationModelPair(choice, settings);
  return { ...settings, ...models };
}
