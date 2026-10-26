/** Compare Windows paths from JSON, file pickers and canonical native paths. */
export function normalizedFilePath(value: string): string {
  let path = value.trim().replace(/\\/g, '/');
  path = path.replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '');
  const windows = /^[a-z]:\//i.test(path) || path.startsWith('//');
  const unc = path.startsWith('//');
  path = path.replace(/\/+/g, '/').replace(/\/$/, '');
  if (unc) path = `/${path}`;
  return windows ? path.toLowerCase() : path;
}

export function sameFilePath(left: string, right: string): boolean {
  return Boolean(left.trim() && right.trim()) && normalizedFilePath(left) === normalizedFilePath(right);
}
