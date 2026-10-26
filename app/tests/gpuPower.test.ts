import { describe, expect, it } from 'vitest';
import { formatGpuWatts, gpuPowerLabel } from '../src/lib/gpuPower';
import { appendRuntimeHistory } from '../src/lib/history';
import { MOCK_RUNTIME } from '../src/mocks/runtime';

describe('GPU driver power readings', () => {
  it('formats measured power without replacing it with a nominal wattage', () => {
    expect(formatGpuWatts(131, 'en')).toBe('131 W');
    expect(formatGpuWatts(38.29, 'en')).toBe('38.3 W');
    expect(formatGpuWatts(0, 'en')).toBe('0 W');
  });
  it('keeps unavailable readings distinct from actual zero', () => {
    for (const value of [null, undefined, NaN, Infinity, -1]) expect(formatGpuWatts(value, 'en')).toBe('—');
    expect(gpuPowerLabel({ ...MOCK_RUNTIME.gpu, powerW: 131, powerReading: 'instant' })).toBe('metrics.powerInstant');
    expect(gpuPowerLabel({ ...MOCK_RUNTIME.gpu, powerW: 38.29, powerReading: 'average' })).toBe('metrics.powerAverage');
    expect(gpuPowerLabel({ ...MOCK_RUNTIME.gpu, powerW: null, powerReading: null })).toBe('metrics.power');
  });
  it('preserves missing telemetry as a gap in chart history', () => {
    const history = appendRuntimeHistory([], { ...MOCK_RUNTIME, gpu: { ...MOCK_RUNTIME.gpu, powerW: null } });
    expect(history[0].gpuPowerW).toBeNull();
  });
});
