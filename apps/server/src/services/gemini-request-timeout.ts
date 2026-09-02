export class GeminiRequestTimeoutError extends Error {
  readonly statusCode = 504;

  constructor(readonly timeoutMs: number) {
    super(`Gemini request timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    this.name = 'GeminiRequestTimeoutError';
  }
}

export async function withGeminiRequestTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new GeminiRequestTimeoutError(timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
