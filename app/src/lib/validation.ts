import { DEFAULT_CONFIG, type LaunchConfig, type LlamaCapabilities } from "../types/config";
import { isParameterValueAvailable, PARAMETER_REGISTRY } from "./parameters";

export interface ValidationIssue {
  field: keyof LaunchConfig | "general";
  severity: "error" | "warning";
  messageKey: string;
  labelKey?: string;
  minimum?: number;
  maximum?: number;
}

export function validateConfig(config: LaunchConfig, capabilities?: LlamaCapabilities): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!config.binaryPath.trim()) issues.push({ field: "binaryPath", severity: "error", messageKey: "validation.binaryRequired" });
  if (!config.modelPath.trim()) issues.push({ field: "modelPath", severity: "error", messageKey: "validation.modelRequired" });
  if (config.batchSize < config.ubatchSize) issues.push({ field: "batchSize", severity: "warning", messageKey: "validation.batchVsUbatch" });
  if (config.host !== "127.0.0.1" && config.host !== "localhost" && !config.apiKey?.trim()) issues.push({ field: "host", severity: "warning", messageKey: "validation.publicNoKey" });
  if (config.splitMode !== "none" && !config.tensorSplit.trim()) issues.push({ field: "tensorSplit", severity: "warning", messageKey: "validation.tensorSplitEmpty" });
  if (config.splitMode === "tensor" && config.fit) issues.push({ field: "fit", severity: "warning", messageKey: "validation.fitTensor" });

  for (const parameter of PARAMETER_REGISTRY) {
    const value = config[parameter.key] as unknown;
    if (typeof value === "number") {
      if (parameter.min !== undefined && value < parameter.min) {
        issues.push({ field: parameter.key, severity: "error", messageKey: "validation.parameterMinimum", labelKey: parameter.labelKey, minimum: parameter.min });
      }
      if (parameter.max !== undefined && value > parameter.max) {
        issues.push({ field: parameter.key, severity: "error", messageKey: "validation.parameterMaximum", labelKey: parameter.labelKey, maximum: parameter.max });
      }
    }
    if (capabilities?.rawHelp !== undefined && parameter.cli && !isParameterValueAvailable(parameter, config, capabilities)) {
      const defaultValue = DEFAULT_CONFIG[parameter.key] as unknown;
      if (JSON.stringify(value) !== JSON.stringify(defaultValue)) {
        issues.push({ field: parameter.key, severity: "warning", messageKey: "validation.parameterUnsupported", labelKey: parameter.labelKey });
      }
    }
  }
  return issues;
}
