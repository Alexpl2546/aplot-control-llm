import { afterEach, describe, expect, it, vi } from 'vitest';
import { uuidV4 } from '../mobile/src/uuid';

afterEach(() => vi.restoreAllMocks());

describe('uuidV4', () => {
  it('uses secure random bytes and sets the RFC 4122 version and variant when randomUUID is unavailable', () => {
    const fillRandomBytes: Crypto['getRandomValues'] = <T extends Exclude<BufferSource, ArrayBuffer>>(array: T): T => {
      if (array instanceof Uint8Array) array.fill(0xff);
      return array;
    };
    const getRandomValues = vi.fn(fillRandomBytes);
    const random = vi.spyOn(Math, 'random');

    expect(uuidV4({ getRandomValues })).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(getRandomValues).toHaveBeenCalledOnce();
    expect(getRandomValues.mock.calls[0]?.[0]).toHaveLength(16);
    expect(random).not.toHaveBeenCalled();
  });

  it('fails closed when neither cryptographic UUID API is available', () => {
    expect(() => uuidV4({})).toThrow('Cryptographic randomness is unavailable');
  });
});
