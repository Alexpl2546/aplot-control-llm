/** Ranks contiguous matches above word starts above loose subsequences; returns -1 when it does not match. */
export function commandScore(text: string, query: string) {
  const haystack = text.toLocaleLowerCase(), needle = query.trim().toLocaleLowerCase();
  if (!needle) return 0;
  const index = haystack.indexOf(needle);
  if (index === 0) return 300;
  if (index > 0) return (/[\s·:/(—-]/.test(haystack[index - 1]!) ? 220 : 160) - Math.min(index, 60);
  const words = needle.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every(word => haystack.includes(word))) return 120;
  let position = 0, gaps = 0;
  for (const character of needle) {
    const next = haystack.indexOf(character, position);
    if (next < 0) return -1;
    gaps += next - position; position = next + 1;
  }
  // Loose subsequences only count when the letters stay close together.
  return gaps <= needle.length * 2 ? Math.max(1, 80 - gaps) : -1;
}
