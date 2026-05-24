import { describe, it, expect } from 'vitest';
import { HermesError, HermesConnectionError, HermesApiError } from '../../utils/errors.js';

describe('HermesError', () => {
  it('is an instance of Error', () => {
    const err = new HermesError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(HermesError);
  });

  it('has name "HermesError"', () => {
    const err = new HermesError('test');
    expect(err.name).toBe('HermesError');
  });

  it('stores the message', () => {
    const err = new HermesError('something broke');
    expect(err.message).toBe('something broke');
  });
});

describe('HermesConnectionError', () => {
  it('extends HermesError and Error', () => {
    const err = new HermesConnectionError('no connection');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(HermesError);
    expect(err).toBeInstanceOf(HermesConnectionError);
  });

  it('has name "HermesConnectionError"', () => {
    const err = new HermesConnectionError('timeout');
    expect(err.name).toBe('HermesConnectionError');
  });
});

describe('HermesApiError', () => {
  it('extends HermesError and Error', () => {
    const err = new HermesApiError('not found', 404);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(HermesError);
    expect(err).toBeInstanceOf(HermesApiError);
  });

  it('has name "HermesApiError"', () => {
    const err = new HermesApiError('fail', 500);
    expect(err.name).toBe('HermesApiError');
  });

  it('stores statusCode', () => {
    const err = new HermesApiError('not found', 404);
    expect(err.statusCode).toBe(404);
  });
});
