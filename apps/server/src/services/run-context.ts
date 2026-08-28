import { AsyncLocalStorage } from 'node:async_hooks';

export interface ProcessingRunContext {
  projectId: string;
  runKey: string;
}

const storage = new AsyncLocalStorage<ProcessingRunContext>();

export function withProcessingRun<T>(context: ProcessingRunContext, operation: () => Promise<T>) {
  return storage.run(context, operation);
}

export function currentProcessingRun() {
  return storage.getStore();
}
