export const gib = (mib: number) => (mib / 1024).toFixed(1);
export const bytesToGiB = (bytes: number) => bytes / 1024 ** 3;
export function duration(seconds: number) {
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
export function relativeDate(iso?: string, locale = "en") {
  if (!iso) return "—";
  const delta = Date.now() - new Date(iso).getTime();
  if (delta < 60_000) return locale.startsWith("ru") ? "только что" : "just now";
  if (delta < 3_600_000) return locale.startsWith("ru") ? `${Math.floor(delta/60_000)} мин назад` : `${Math.floor(delta/60_000)} min ago`;
  if (delta < 86_400_000) return locale.startsWith("ru") ? `${Math.floor(delta/3_600_000)} ч назад` : `${Math.floor(delta/3_600_000)} h ago`;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(iso));
}
