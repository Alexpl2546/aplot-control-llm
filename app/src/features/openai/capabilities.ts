export type ChatFeature = 'webSearch' | 'hostedFileSearch' | 'codeInterpreter' | 'imageGeneration' | 'realtime';
export interface Capability { state: 'conditional' | 'unavailable'; reason: 'modelAndAccount' | 'authMode' | 'notIntegrated' | 'runtime'; }
export interface ChatCapabilityContext { provider: 'local' | 'chatgpt' | 'claude'; authMode?: 'chatgpt' | 'apiKey'; }

/** A catalogue entry is not an entitlement check. Never present conditional tools as verified. */
export function chatCapability(context: ChatCapabilityContext, feature: ChatFeature): Capability {
  if (context.provider !== 'chatgpt') return { state: 'unavailable', reason: 'runtime' };
  if (feature === 'webSearch') return { state: 'conditional', reason: 'modelAndAccount' };
  if (context.authMode !== 'apiKey') return { state: 'unavailable', reason: 'authMode' };
  return { state: 'unavailable', reason: 'notIntegrated' };
}
