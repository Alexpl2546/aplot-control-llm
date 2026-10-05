export interface FriendlyError {
  titleKey: string;
  messageKey: string;
  technical: string;
}

export function classifyError(error: unknown): FriendlyError {
  const technical = error instanceof Error ? error.message : String(error ?? "Unknown error");
  const text = technical.toLowerCase();
  if (/capability|--help.*missing|detect.*before launch/.test(text)) return { titleKey: "error.detectTitle", messageKey: "error.detectText", technical };
  if (/address already in use|10048|eaddrinuse|port.*in use/.test(text)) return { titleKey: "error.portTitle", messageKey: "error.portText", technical };
  if (/401|403|unauthorized|forbidden|api.?key/.test(text)) return { titleKey: "error.authTitle", messageKey: "error.authText", technical };
  if (/model|gguf/.test(text) && /not found|failed|invalid|open|read/.test(text)) return { titleKey: "error.modelTitle", messageKey: "error.modelText", technical };
  if (/access is denied|permission denied|os error 5|administrator privileges/.test(text)) return { titleKey: "error.permissionTitle", messageKey: "error.permissionText", technical };
  if (/timed out|timeout|deadline has elapsed/.test(text)) return { titleKey: "error.timeoutTitle", messageKey: "error.timeoutText", technical };
  if (/invalid profile|profile.*invalid|profile validation/.test(text)) return { titleKey: "error.profileTitle", messageKey: "error.profileText", technical };
  if (/enoent|cannot find|failed to run --version|llama-server\.exe.*not found|binary.*not found/.test(text)) return { titleKey: "error.binaryTitle", messageKey: "error.binaryText", technical };
  if (/failed to start|spawn|process/.test(text)) return { titleKey: "error.processTitle", messageKey: "error.processText", technical };
  return { titleKey: "error.genericTitle", messageKey: "error.genericText", technical };
}
