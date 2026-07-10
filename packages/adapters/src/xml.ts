import { XMLParser } from 'fast-xml-parser';

/**
 * Shared XML plumbing for the Atom (EDGAR) and RSS/Atom (generic feed) adapters.
 *
 * fast-xml-parser collapses single-child elements to plain objects and mixed
 * text/attribute nodes to `{ '#text': …, '@_attr': … }`. The helpers below
 * normalize those shapes so adapter code never touches `any`.
 */

/** Element paths that must always parse as arrays, even with a single child. */
const ARRAY_JPATHS = new Set([
  'feed.entry',
  'feed.entry.link',
  'feed.entry.category',
  'rss.channel.item',
  'rss.channel.item.category',
]);

export function parseXml(xml: string): unknown {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    // Keep values as strings: numeric-looking guids/ciks must not become numbers.
    parseTagValue: false,
    trimValues: true,
    isArray: (_tagName, jPath) => ARRAY_JPATHS.has(jPath),
  });
  return parser.parse(xml) as unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Text content of a node that may be a string, number, `{ '#text': … }`, or array. */
export function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return textOf(value[0]);
  if (isRecord(value)) return textOf(value['#text']);
  return undefined;
}

/** Attribute value of a node object (e.g. `attrOf(link, 'href')`). */
export function attrOf(value: unknown, attr: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const raw = value[`@_${attr}`];
  if (typeof raw === 'string') return raw.length > 0 ? raw : undefined;
  if (typeof raw === 'number') return String(raw);
  return undefined;
}

/**
 * Resolve an Atom/RSS `link` value to an href. Handles: plain text (RSS 2.0),
 * a single `<link href=…>` object, or an array of Atom link objects (prefer
 * rel="alternate", else the first that carries an href).
 */
export function linkHref(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  const candidates = Array.isArray(value) ? value : [value];
  let first: string | undefined;
  for (const candidate of candidates) {
    const href = attrOf(candidate, 'href') ?? textOf(candidate);
    if (href === undefined) continue;
    if (attrOf(candidate, 'rel') === 'alternate') return href;
    first ??= href;
  }
  return first;
}

/** Parse a feed-provided date (RFC822 or ISO) into a strict ISO-8601 string. */
export function toIsoDate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString();
}

/** Strip HTML tags/entities from feed-provided rich text (descriptions, summaries). */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
