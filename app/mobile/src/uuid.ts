type UuidCrypto = Partial<Pick<Crypto, 'randomUUID' | 'getRandomValues'>>;

export function uuidV4(cryptoApi: UuidCrypto | undefined = globalThis.crypto): string {
  const randomUUID = cryptoApi?.randomUUID;
  if (typeof randomUUID === 'function') return randomUUID.call(cryptoApi);

  const getRandomValues = cryptoApi?.getRandomValues;
  if (typeof getRandomValues !== 'function') {
    throw new Error('Cryptographic randomness is unavailable');
  }

  const bytes = new Uint8Array(16);
  getRandomValues.call(cryptoApi, bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
