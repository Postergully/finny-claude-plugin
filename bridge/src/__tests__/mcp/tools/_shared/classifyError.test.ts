import { describe, it, expect } from 'vitest';
import { classifyError } from '../../../../mcp/tools/_shared/classifyError.js';

describe('classifyError', () => {
  it('maps 401 to unauthorized non-retryable', () => {
    const err = Object.assign(new Error('nope'), { status: 401 });
    expect(classifyError(err)).toEqual({ code: 'unauthorized', retryable: false });
  });

  it('maps 4xx to gateway_rejected non-retryable', () => {
    const err = Object.assign(new Error('bad req'), { status: 400 });
    expect(classifyError(err)).toEqual({ code: 'gateway_rejected', retryable: false });
  });

  it('maps timeout message to timeout retryable', () => {
    expect(classifyError(new Error('Request timed out after 45000ms'))).toEqual({
      code: 'timeout',
      retryable: true,
    });
  });

  it('maps connect failures to gateway_unreachable retryable', () => {
    expect(classifyError(new Error('Failed to connect to 127.0.0.1:18789'))).toEqual({
      code: 'gateway_unreachable',
      retryable: true,
    });
  });

  it('falls through to internal', () => {
    expect(classifyError(new Error('boom'))).toEqual({ code: 'internal', retryable: false });
  });
});
