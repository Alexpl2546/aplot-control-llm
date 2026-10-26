import { describe, expect, it, vi } from 'vitest';
import { cachedModule } from '../src/lib/viewModules';

describe('view preloading', () => {
  it('shares an in-flight module between hover preloading and navigation', async () => {
    let resolve!: (value: { screen: string }) => void;
    const load = vi.fn(() => new Promise<{ screen: string }>(done => { resolve = done; }));
    const cached = cachedModule(load);
    const hover = cached(), navigation = cached();
    expect(hover).toBe(navigation);
    expect(load).toHaveBeenCalledTimes(1);
    resolve({ screen: 'chat' });
    await expect(navigation).resolves.toEqual({ screen: 'chat' });
    expect(cached()).toBe(hover);
  });

  it('allows navigation to retry after a failed speculative preload', async () => {
    const load = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error('temporary load failure')).mockResolvedValueOnce('ready');
    const cached = cachedModule(load);
    await expect(cached()).rejects.toThrow('temporary load failure');
    await expect(cached()).resolves.toBe('ready');
    expect(load).toHaveBeenCalledTimes(2);
  });
});
