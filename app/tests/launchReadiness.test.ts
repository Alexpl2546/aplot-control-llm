import { describe, expect, it } from 'vitest';
import { launchBlocker } from '../src/features/launches/readiness';
import { normalizedFilePath, sameFilePath } from '../src/lib/filePaths';
import { configuredContextSize, strataModelForConfig } from '../src/lib/serverContext';
import { DEFAULT_SETTINGS } from '../src/types/app';
import { DEFAULT_CONFIG } from '../src/types/config';

describe('Windows launch paths', () => {
  it('matches canonical, mixed separator, repeated separator and case variants', () => {
    const saved = 'C:\\\\Dev\\\\Strata\\\\strata-flash.json';
    const native = '\\\\?\\C:\\Dev\\Strata\\strata-flash.json';
    expect(sameFilePath(saved, native)).toBe(true);
    expect(sameFilePath(native, 'c:/dev/strata/strata-flash.json')).toBe(true);
    expect(sameFilePath('C:/dev/strata-qwen.json', native)).toBe(false);
    expect(sameFilePath('', '')).toBe(false);
    expect(normalizedFilePath('\\\\?\\UNC\\server\\share\\model.json')).toBe('//server/share/model.json');
    expect(sameFilePath('/models/A.gguf', '/models/a.gguf')).toBe(false);
  });
  it('finds the same Strata config and its context despite Windows path formatting', () => {
    const settings = { ...DEFAULT_SETTINGS, serverEngine: 'strata' as const, strataRootPath: 'C:\\Strata', strataConfigPath: 'C:\\\\Strata\\\\strata-flash.json' };
    const models = [{ configPath: '\\\\?\\C:\\Strata\\strata-flash.json', modelName: 'Flash', contextLength: 131072 }];
    expect(strataModelForConfig(models, settings.strataConfigPath)?.modelName).toBe('Flash');
    expect(configuredContextSize('strata', DEFAULT_CONFIG, settings, models)).toBe(131072);
    expect(launchBlocker(DEFAULT_CONFIG, settings)).toBeUndefined();
  });
  it('reports actual missing prerequisites rather than requiring a discovery-list membership', () => {
    const settings = { ...DEFAULT_SETTINGS, serverEngine: 'strata' as const };
    expect(launchBlocker(DEFAULT_CONFIG, settings)).toBe('launches.blocked.strataRoot');
    settings.strataRootPath = 'C:\\Strata';
    expect(launchBlocker(DEFAULT_CONFIG, settings)).toBe('launches.blocked.strataConfig');
    settings.strataConfigPath = 'C:\\Strata\\strata-flash.json';
    expect(launchBlocker(DEFAULT_CONFIG, settings)).toBeUndefined();
  });
});
