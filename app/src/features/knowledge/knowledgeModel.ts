/** Prefix of in-app links produced from Obsidian `[[wiki links]]`. */
export const NOTE_LINK = '#aplot-note=';

/** Lowercase and treat «ё» as «е», matching the index normalization. */
export const foldText = (text: string) => text.toLocaleLowerCase().replace(/ё/g, 'е');

export function queryTerms(query: string): string[] {
  return [...new Set(foldText(query).split(/[^\p{L}\p{N}_]+/u).map(term => term.replace(/^_+|_+$/g, '')).filter(Boolean))].slice(0, 12);
}

/** Split text into plain and matched parts for highlighting search terms. */
export function highlightParts(text: string, query: string): { text: string; match: boolean }[] {
  const terms = queryTerms(query).sort((a, b) => b.length - a.length);
  if (!terms.length) return [{ text, match: false }];
  const folded = foldText(text);
  const parts: { text: string; match: boolean }[] = [];
  let index = 0, plain = 0;
  while (index < text.length) {
    const term = terms.find(item => folded.startsWith(item, index));
    if (term) {
      if (plain < index) parts.push({ text: text.slice(plain, index), match: false });
      parts.push({ text: text.slice(index, index + term.length), match: true });
      index += term.length; plain = index;
    } else index += 1;
  }
  if (plain < text.length) parts.push({ text: text.slice(plain), match: false });
  return parts;
}

/** Obsidian wiki links and embeds become ordinary Markdown outside code. */
export function wikiToMarkdown(body: string): string {
  let fence = '';
  return body.split('\n').map(line => {
    const opener = /^\s*(```|~~~)/.exec(line)?.[1];
    if (opener) { fence = fence === opener ? '' : fence || opener; return line; }
    if (fence) return line;
    return line.split(/(`[^`]*`)/).map(part => part.startsWith('`') ? part : part
      .replace(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, (_, target: string) => `\`${target.trim()}\``)
      .replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_, target: string, alias?: string) => {
        const label = (alias || target.split('#')[0] || target).trim().replace(/[[\]]/g, '');
        return `[${label}](${NOTE_LINK}${encodeURIComponent(target.trim())})`;
      })).join('');
  }).join('\n');
}

/** Candidate vault paths for a wiki or relative Markdown link target. */
export function linkCandidates(target: string, fromPath: string): string[] {
  const clean = target.split('#')[0].split('^')[0].trim().replace(/\\/g, '/');
  if (!clean) return [];
  const withExt = /\.(md|markdown)$/i.test(clean) ? clean : `${clean}.md`;
  const folder = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
  const relative = folder ? `${folder}/${withExt}` : withExt;
  const normalized = relative.split('/').reduce<string[]>((parts, part) => {
    if (part === '..') parts.pop(); else if (part && part !== '.') parts.push(part);
    return parts;
  }, []).join('/');
  return [...new Set([withExt.replace(/^\/+/, ''), normalized])];
}

export const stemOf = (path: string) => (path.split('/').at(-1) ?? path).replace(/\.(md|markdown)$/i, '');

/** Error codes from the knowledge commands that have their own message. */
const KNOWN_ERRORS = ['knowledge-folder', 'knowledge-folder-root', 'knowledge-overlap', 'knowledge-limit', 'knowledge-missing', 'knowledge-path', 'knowledge-exclusion', 'desktop-only'];
export function knowledgeErrorKey(error: unknown): string {
  const text = String(error instanceof Error ? error.message : error);
  const code = KNOWN_ERRORS.filter(item => text.includes(item)).sort((a, b) => b.length - a.length)[0];
  return code ? `knowledge.error.${code}` : 'knowledge.error.generic';
}
