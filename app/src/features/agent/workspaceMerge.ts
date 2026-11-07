export type WorkspaceArrayKey = 'projects' | 'tasks' | 'presets' | 'memory';

export interface WorkspaceMergeConflict {
  path: string;
  reason: 'field' | 'edit-delete' | 'order' | 'invalid-array' | 'reference-delete';
  base?: unknown;
  local?: unknown;
  remote?: unknown;
}

export interface WorkspaceMergeResult {
  data: Record<string, unknown>;
  conflicts: WorkspaceMergeConflict[];
}

const MISSING = Symbol('missing-workspace-value');
type Value = unknown | typeof MISSING;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Match the JSON shape persisted by Tauri/localStorage; optional undefined fields are omitted. */
export function cloneWorkspaceData(value: Record<string, unknown>): Record<string, unknown> {
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(value => value === undefined ? null : visit(value));
    if (isObject(item)) {
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(item)) if (child !== undefined) result[key] = visit(child);
      return result;
    }
    return item;
  };
  return visit(value) as Record<string, unknown>;
}

function equal(left: Value, right: Value): boolean {
  if (left === MISSING || right === MISSING) return left === right;
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => equal(value, right[index]));
  }
  if (isObject(left) || isObject(right)) {
    if (!isObject(left) || !isObject(right)) return false;
    const leftKeys = Object.keys(left).filter(key => left[key] !== undefined).sort();
    const rightKeys = Object.keys(right).filter(key => right[key] !== undefined).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && equal(left[key], right[key]));
  }
  return false;
}

function member(object: Value, key: string): Value {
  if (!isObject(object) || !Object.prototype.hasOwnProperty.call(object, key) || object[key] === undefined) return MISSING;
  return object[key];
}

function printable(value: Value): unknown {
  return value === MISSING ? undefined : cloneValue(value);
}

function cloneValue(value: Value): unknown {
  if (value === MISSING) return undefined;
  if (Array.isArray(value)) return value.map(item => cloneValue(item));
  if (isObject(value)) {
    const copy: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) if (child !== undefined) copy[key] = cloneValue(child);
    return copy;
  }
  return value;
}

function conflict(
  conflicts: WorkspaceMergeConflict[],
  path: string,
  reason: WorkspaceMergeConflict['reason'],
  base: Value,
  local: Value,
  remote: Value,
) {
  conflicts.push({ path, reason, base: printable(base), local: printable(local), remote: printable(remote) });
}

/** Three-way merge for one JSON value. Conflicts always retain the local value. */
function mergeValue(
  base: Value,
  local: Value,
  remote: Value,
  path: string,
  conflicts: WorkspaceMergeConflict[],
  policy?: WorkspaceArrayKey,
): Value {
  if (policy === 'tasks' && path.endsWith('.updatedAt')) {
    const timestamps = [base, local, remote].filter((value): value is number => typeof value === 'number');
    return timestamps.length ? Math.max(...timestamps) : MISSING;
  }
  if (policy === 'tasks' && path.endsWith('.unread')) {
    return cloneValue(equal(local, base) ? remote : local) as Value;
  }
  if (equal(local, base)) return cloneValue(remote) as Value;
  if (equal(remote, base) || equal(local, remote)) return cloneValue(local) as Value;

  const localDeleted = local === MISSING;
  const remoteDeleted = remote === MISSING;
  if (localDeleted || remoteDeleted) {
    conflict(conflicts, path, 'edit-delete', base, local, remote);
    return cloneValue(local) as Value;
  }

  if (isObject(local) && isObject(remote) && (base === MISSING || isObject(base))) {
    const baseObject = base === MISSING ? {} : base as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    const keys = new Set([...Object.keys(baseObject), ...Object.keys(local), ...Object.keys(remote)]);
    for (const key of keys) {
      const merged = mergeValue(member(baseObject, key), member(local, key), member(remote, key), path ? `${path}.${key}` : key, conflicts, policy);
      if (merged !== MISSING) result[key] = cloneValue(merged);
    }
    return result;
  }

  conflict(conflicts, path, 'field', base, local, remote);
  return cloneValue(local) as Value;
}

function keyedItems(value: Value): Map<string, Record<string, unknown>> | undefined {
  if (value === MISSING) return new Map();
  if (!Array.isArray(value)) return undefined;
  const result = new Map<string, Record<string, unknown>>();
  for (const item of value) {
    if (!isObject(item) || typeof item.id !== 'string' || !item.id || result.has(item.id)) return undefined;
    result.set(item.id, item);
  }
  return result;
}

function sameOrder(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function mergeOrder(
  key: WorkspaceArrayKey,
  base: Map<string, Record<string, unknown>>,
  local: Map<string, Record<string, unknown>>,
  remote: Map<string, Record<string, unknown>>,
  mergedIds: Set<string>,
  conflicts: WorkspaceMergeConflict[],
): string[] {
  const baseOrder = [...base.keys()].filter(id => mergedIds.has(id));
  const localOrder = [...local.keys()].filter(id => mergedIds.has(id));
  const remoteOrder = [...remote.keys()].filter(id => mergedIds.has(id));
  const common = new Set([...base.keys()].filter(id => local.has(id) && remote.has(id) && mergedIds.has(id)));
  const baseCommon = baseOrder.filter(id => common.has(id));
  const localCommon = localOrder.filter(id => common.has(id));
  const remoteCommon = remoteOrder.filter(id => common.has(id));
  const localReordered = !sameOrder(localCommon, baseCommon);
  const remoteReordered = !sameOrder(remoteCommon, baseCommon);
  const conflictOrder = localReordered && remoteReordered && !sameOrder(localCommon, remoteCommon);

  if (conflictOrder) {
    conflict(conflicts, `${key}.$order`, 'order', baseOrder, localOrder, remoteOrder);
  }
  const primary = localReordered || conflictOrder ? localOrder : remoteOrder;
  const secondary = localReordered || conflictOrder ? remoteOrder : localOrder;
  const result = [...primary];
  for (const id of secondary) if (!result.includes(id)) result.push(id);
  for (const id of mergedIds) if (!result.includes(id)) result.push(id);
  return result;
}

function mergeKeyedArray(
  key: WorkspaceArrayKey,
  baseValue: Value,
  localValue: Value,
  remoteValue: Value,
  conflicts: WorkspaceMergeConflict[],
): unknown[] | undefined {
  const base = keyedItems(baseValue), local = keyedItems(localValue), remote = keyedItems(remoteValue);
  if (!base || !local || !remote) {
    conflict(conflicts, key, 'invalid-array', baseValue, localValue, remoteValue);
    return Array.isArray(localValue) ? cloneValue(localValue) as unknown[] : undefined;
  }
  const merged = new Map<string, Record<string, unknown>>();
  const ids = new Set([...base.keys(), ...local.keys(), ...remote.keys()]);
  for (const id of ids) {
    const baseItem = base.get(id), localItem = local.get(id), remoteItem = remote.get(id);
    const result = mergeValue(
      baseItem ?? MISSING,
      localItem ?? MISSING,
      remoteItem ?? MISSING,
      `${key}[id=${JSON.stringify(id)}]`,
      conflicts,
      key,
    );
    if (result !== MISSING && isObject(result)) {
      merged.set(id, result);
    }
  }
  const order = mergeOrder(key, base, local, remote, new Set(merged.keys()), conflicts);
  return order.map(id => merged.get(id)!);
}

function recordsById(value: unknown): Map<string, Record<string, unknown>> {
  if (!Array.isArray(value)) return new Map();
  return new Map(value.filter((item): item is Record<string, unknown> => isObject(item) && typeof item.id === 'string').map(item => [item.id as string, item]));
}

function ensureReference(
  data: Record<string, unknown>,
  entityMaps: Record<WorkspaceArrayKey, { base: Map<string, Record<string, unknown>>; local: Map<string, Record<string, unknown>>; remote: Map<string, Record<string, unknown>>; current: Map<string, Record<string, unknown>> }>,
  key: WorkspaceArrayKey,
  id: string,
  conflicts: WorkspaceMergeConflict[],
  required: boolean,
): Record<string, unknown> | undefined {
  const current = entityMaps[key].current;
  const found = current.get(id);
  if (found) return found;
  const baseRecord = entityMaps[key].base.get(id);
  const localRecord = entityMaps[key].local.get(id);
  const remoteRecord = entityMaps[key].remote.get(id);
  const dependency = remoteRecord ?? localRecord ?? baseRecord;
  if (!dependency && !required) return undefined;
  conflict(
    conflicts,
    `${key}[id=${JSON.stringify(id)}].$requiredBy`,
    'reference-delete',
    baseRecord ?? MISSING,
    localRecord ?? MISSING,
    remoteRecord ?? MISSING,
  );
  if (!dependency) return undefined;
  const items = Array.isArray(data[key]) ? data[key] as unknown[] : [];
  const sourceOrder = entityMaps[key].remote.has(id)
    ? [...entityMaps[key].remote.keys()]
    : entityMaps[key].local.has(id) ? [...entityMaps[key].local.keys()] : [...entityMaps[key].base.keys()];
  const sourceIndex = sourceOrder.indexOf(id);
  let insertAt = items.length;
  for (let index = sourceIndex + 1; index < sourceOrder.length; index++) {
    const nextId = sourceOrder[index];
    const currentIndex = items.findIndex(item => isObject(item) && item.id === nextId);
    if (currentIndex >= 0) { insertAt = currentIndex; break; }
  }
  const restored = cloneValue(dependency) as Record<string, unknown>;
  items.splice(insertAt, 0, restored);
  data[key] = items;
  current.set(id, restored);
  return dependency;
}

/** Keep referenced workspace entities when a concurrent deletion would orphan a server task. */
function retainReferencedEntities(
  data: Record<string, unknown>,
  base: Record<string, unknown>,
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  conflicts: WorkspaceMergeConflict[],
) {
  const entityMaps = Object.fromEntries((['projects', 'tasks', 'presets', 'memory'] as WorkspaceArrayKey[]).map(key => [key, {
    base: recordsById(base[key]), local: recordsById(local[key]), remote: recordsById(remote[key]), current: recordsById(data[key]),
  }])) as Record<WorkspaceArrayKey, { base: Map<string, Record<string, unknown>>; local: Map<string, Record<string, unknown>>; remote: Map<string, Record<string, unknown>>; current: Map<string, Record<string, unknown>> }>;
  const projectsSeen = new Set<string>(), presetsSeen = new Set<string>();
  const taskQueue = [...entityMaps.tasks.current.values()];
  const processedTasks = new Set<string>();
  while (taskQueue.length) {
    const task = taskQueue.shift()!;
    const taskId = typeof task.id === 'string' ? task.id : '';
    if (!taskId || processedTasks.has(taskId)) continue;
    processedTasks.add(taskId);
    const baseTask = entityMaps.tasks.base.get(taskId);
    const localTask = entityMaps.tasks.local.get(taskId);
    const remoteTask = entityMaps.tasks.remote.get(taskId);
    const taskChanged = !equal(localTask ?? MISSING, baseTask ?? MISSING) || !equal(remoteTask ?? MISSING, baseTask ?? MISSING);
    if (taskChanged && typeof task.parentTaskId === 'string' && task.parentTaskId) {
      const parent = ensureReference(data, entityMaps, 'tasks', task.parentTaskId, conflicts, false);
      if (parent && !processedTasks.has(task.parentTaskId)) taskQueue.push(parent);
    }
    if (taskChanged) {
      const presetIds = [task.presetId, ...(Array.isArray(task.collaboratorPresetIds) ? task.collaboratorPresetIds : [])];
      for (const presetId of presetIds) {
        if (typeof presetId !== 'string' || !presetId || presetsSeen.has(presetId)) continue;
        presetsSeen.add(presetId);
        ensureReference(data, entityMaps, 'presets', presetId, conflicts, false);
      }
    }
    if (typeof task.projectId === 'string' && task.projectId && !projectsSeen.has(task.projectId)) {
      projectsSeen.add(task.projectId);
      ensureReference(data, entityMaps, 'projects', task.projectId, conflicts, taskChanged);
    }
  }

  for (const preset of entityMaps.presets.current.values()) {
    const presetId = typeof preset.id === 'string' ? preset.id : '';
    const basePreset = entityMaps.presets.base.get(presetId);
    const localPreset = entityMaps.presets.local.get(presetId);
    const remotePreset = entityMaps.presets.remote.get(presetId);
    const presetChanged = !equal(localPreset ?? MISSING, basePreset ?? MISSING) || !equal(remotePreset ?? MISSING, basePreset ?? MISSING);
    if (!presetChanged) continue;
    if (!Array.isArray(preset.projectIds)) continue;
    for (const projectId of preset.projectIds) {
      if (typeof projectId !== 'string' || !projectId || projectsSeen.has(projectId)) continue;
      projectsSeen.add(projectId);
      ensureReference(data, entityMaps, 'projects', projectId, conflicts, presetChanged);
    }
  }
}

const keyedArrays = new Set<WorkspaceArrayKey>(['projects', 'tasks', 'presets', 'memory']);
const windowLocalFields = new Set(['threads', 'selectedProjectId', 'selectedTaskId', 'mode']);

/**
 * Merge an acknowledged server base, the current window state and a newer
 * server snapshot. Keyed workspace entities merge by ID and then by field.
 * Same-field and edit/delete conflicts retain local data and are returned.
 */
export function mergeWorkspace(
  baseInput: Record<string, unknown>,
  localInput: Record<string, unknown>,
  remoteInput: Record<string, unknown>,
): WorkspaceMergeResult {
  const base = cloneWorkspaceData(baseInput), local = cloneWorkspaceData(localInput), remote = cloneWorkspaceData(remoteInput);
  const result: Record<string, unknown> = {};
  const conflicts: WorkspaceMergeConflict[] = [];
  const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
  for (const key of keys) {
    if (windowLocalFields.has(key)) {
      const value = member(local, key);
      if (value !== MISSING) result[key] = cloneValue(value);
      continue;
    }
    if (keyedArrays.has(key as WorkspaceArrayKey)) {
      const value = mergeKeyedArray(key as WorkspaceArrayKey, member(base, key), member(local, key), member(remote, key), conflicts);
      if (value !== undefined) result[key] = value;
      continue;
    }
    const value = mergeValue(member(base, key), member(local, key), member(remote, key), key, conflicts);
    if (value !== MISSING) result[key] = cloneValue(value);
  }
  retainReferencedEntities(result, base, local, remote, conflicts);
  return { data: result, conflicts };
}

export function workspaceDataEqual(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return equal(cloneWorkspaceData(left), cloneWorkspaceData(right));
}
