import type { AplotClient } from './agentTaskClient';
import { tauriAplotClient } from './tauriAgentTaskClient';

interface ClientOverride { client: AplotClient; active: boolean; }
const overrides: ClientOverride[] = [];
let selectedClient: AplotClient = tauriAplotClient;
let selectionGeneration = 0;

function effectiveClient(): AplotClient {
  return overrides.at(-1)?.client ?? tauriAplotClient;
}

function refreshSelection(): void {
  const next = effectiveClient();
  if (next === selectedClient) return;
  selectedClient = next;
  selectionGeneration++;
}

/** The normal application transport is explicitly the native Tauri client. */
export function getAplotClient(): AplotClient {
  return getAplotClientSelection().client;
}

/** Identifies the effective client selection so callbacks from an older selection can be fenced. */
export function getAplotClientSelection(): { client: AplotClient; generation: number } {
  refreshSelection();
  return { client: selectedClient, generation: selectionGeneration };
}

export function isCurrentAplotClientSelection(selection: { client: AplotClient; generation: number }): boolean {
  const current = getAplotClientSelection();
  return current.client === selection.client && current.generation === selection.generation;
}

/** Select a client for a bounded scope; the returned cleanup is safe to call more than once or out of order. */
export function selectAplotClient(client: AplotClient): () => void {
  const override = { client, active: true };
  overrides.push(override);
  refreshSelection();
  return () => {
    if (!override.active) return;
    override.active = false;
    const index = overrides.indexOf(override);
    if (index >= 0) overrides.splice(index, 1);
    refreshSelection();
  };
}

/** Test and teardown hook that restores the shipped client and clears scoped selections. */
export function resetAplotClient(): void {
  for (const override of overrides) override.active = false;
  overrides.length = 0;
  refreshSelection();
}

export async function withAplotClient<T>(client: AplotClient, operation: () => T | Promise<T>): Promise<T> {
  const restore = selectAplotClient(client);
  try { return await operation(); }
  finally { restore(); }
}
