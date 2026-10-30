import { AsyncLocalStorage } from 'node:async_hooks';
import type { GenerationModelPair } from './generation-settings.js';

export interface ProcessingRunContext {
  projectId: string;
  runKey: string;
  geminiModels?: GenerationModelPair;
}

const storage = new AsyncLocalStorage<ProcessingRunContext>();

export function withProcessingRun<T>(context: ProcessingRunContext, operation: () => Promise<T>) {
  return storage.run(context, operation);
}

export function currentProcessingRun() {
  return storage.getStore();
}
