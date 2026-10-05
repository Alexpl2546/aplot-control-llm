import type { LaunchConfig } from "../types/config";

/** The executable selected in Settings is shared by every profile. */
export function withConfiguredBinary(config: LaunchConfig, configuredBinaryPath: string): LaunchConfig {
  const binaryPath = configuredBinaryPath.trim();
  return binaryPath && config.binaryPath !== binaryPath ? { ...config, binaryPath } : config;
}
