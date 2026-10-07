export function supportsPlatform(item, platform = process.platform, arch = process.arch) {
  const matches = (values, current) => !values || (
    !values.includes(`!${current}`) &&
    (values.includes("any") || values.includes(current) || values.every(value => value.startsWith("!")))
  );
  return matches(item.os, platform) && matches(item.cpu, arch);
}
