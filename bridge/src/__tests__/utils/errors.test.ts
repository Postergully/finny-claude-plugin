import { describe, it, expect } from 'vitest';
import { OpenClawError, OpenClawConnectionError, OpenClawApiError } from '../../utils/errors.js';

describe('OpenClawError', () => {
  it('is an instance of Error', () => {
    const err = new OpenClawError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(OpenClawError);
  });

  it('has name "OpenClawError"', () => {
    const err = new OpenClawError('test');
    expect(err.name).toBe('OpenClawError');
  });

  it('stores the message', () => {
    const err = new OpenClawError('something broke');
    expect(err.message).toBe('something broke');
  });
});

describe('OpenClawConnectionError', () => {
  it('extends OpenClawError and Error', () => {
    const err = new OpenClawConnectionError('no connection');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(OpenClawError);
    expect(err).toBeInstanceOf(OpenClawConnectionError);
  });

  it('has name "OpenClawConnectionError"', () => {
    const err = new OpenClawConnectionError('timeout');
    expect(err.name).toBe('OpenClawConnectionError');
  });
});

describe('OpenClawApiError', () => {
  it('extends OpenClawError and Error', () => {
    const err = new OpenClawApiError('not found', 404);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(OpenClawError);
    expect(err).toBeInstanceOf(OpenClawApiError);
  });

  it('has name "OpenClawApiError"', () => {
    const err = new OpenClawApiError('fail', 500);
    expect(err.name).toBe('OpenClawApiError');
  });

  it('stores statusCode', () => {
    const err = new OpenClawApiError('not found', 404);
    expect(err.statusCode).toBe(404);
  });
});
