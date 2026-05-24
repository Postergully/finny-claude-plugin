// Shared error classifier — maps thrown errors (OpenClawApiError, network
// errors, timeouts) to the ErrorCodeSchema values the judge-loop branches on.
// Extracted for reuse across the async chat pipeline + future report /
// executeSuiteQL handlers.

export interface ClassifiedError {
  code: 'gateway_rejected' | 'gateway_unreachable' | 'timeout' | 'unauthorized' | 'internal';
  retryable: boolean;
}

export function classifyError(err: unknown): ClassifiedError {
  const msg = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: number } | undefined)?.status;
  if (status === 401) return { code: 'unauthorized', retryable: false };
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return { code: 'gateway_rejected', retryable: false };
  }
  if (/timed out/i.test(msg)) return { code: 'timeout', retryable: true };
  if (/Failed to connect/i.test(msg)) {
    return { code: 'gateway_unreachable', retryable: true };
  }
  return { code: 'internal', retryable: false };
}
