const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
  hellip: '...',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  deg: '°',
  euro: '€',
  eacute: 'é',
  egrave: 'è',
  euml: 'ë',
  iuml: 'ï',
  ouml: 'ö',
  uuml: 'ü',
  auml: 'ä',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const value =
        code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

/** Strip tags and collapse whitespace; keeps paragraph breaks. */
export function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function pageTitle(html: string): string | undefined {
  const og = /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i.exec(html);
  if (og?.[1]) return decodeEntities(og[1]).trim();
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return title?.[1] ? stripTags(title[1]) : undefined;
}

/** Readable text of a page: drops scripts, styles, navigation, headers, footers and forms. */
export function readableText(html: string): string {
  const main = /<(main|article)\b[\s\S]*?<\/\1>/i.exec(html)?.[0] ?? html;
  return stripTags(
    main
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(
        /<(script|style|noscript|svg|template|iframe|form|nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi,
        ' ',
      ),
  );
}

/** Every JSON-LD block on the page, parsed; malformed blocks are skipped. */
export function jsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const pattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    const text = match[1]?.trim();
    if (!text) continue;
    try {
      blocks.push(JSON.parse(text));
    } catch {
      try {
        // Some sites put raw newlines inside strings.
        blocks.push(JSON.parse(text.replace(/[\r\n\t]+/g, ' ')));
      } catch {
        /* not parseable */
      }
    }
  }
  return blocks;
}
