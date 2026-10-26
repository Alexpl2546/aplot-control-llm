/** Language gate for displayed prose, excluding code and URLs. This is a heuristic, not a semantic validator. */
export function isRussianReasoning(text: string) {
  const prose = text.replace(/```[\s\S]*?```|`[^`]*`|https?:\/\/\S+/g, '');
  return prose.split(/\n\s*\n/).every(paragraph => {
    const letters = paragraph.match(/\p{L}/gu) ?? [];
    const russian = paragraph.match(/[а-яё]/gi) ?? [];
    return letters.length === 0 || russian.length / letters.length >= .55;
  });
}

/** Bound translation prompts to small contexts without dropping source text. */
export function reasoningChunks(text: string, limit = 2400) {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const boundary = Math.max(remaining.lastIndexOf('\n', limit), remaining.lastIndexOf(' ', limit));
    let end = boundary > limit / 2 ? boundary + 1 : limit;
    if (/[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
    chunks.push(remaining.slice(0, end)); remaining = remaining.slice(end);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
