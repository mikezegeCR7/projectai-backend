import * as cheerio from 'cheerio';

const REMOVE_SELECTORS = [
  'script',
  'style',
  'noscript',
  'nav',
  'header',
  'footer',
  'form',
  'iframe',
  'svg',
  '[aria-hidden="true"]',
];

const BLOCK_TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'pre', 'td'];

/**
 * Converts an HTML page into normalized readable text, per the locked
 * Slice 2 "extracted text" step. This is a boilerplate-reduction pass
 * (strips script/style/nav/header/footer and joins block-level text),
 * not a full Readability-grade extractor — it will sometimes keep a
 * sidebar or byline that a heavier extractor would drop. Flagged as a
 * scoping limitation for this slice, not silently presented as
 * complete.
 */
export function htmlToReadableText(html: string): string {
  const $ = cheerio.load(html);
  REMOVE_SELECTORS.forEach((selector) => $(selector).remove());

  const parts: string[] = [];
  $('body')
    .find(BLOCK_TAGS.join(','))
    .each((_, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      if (text) parts.push(text);
    });

  if (parts.length === 0) {
    // Fallback for pages that don't use conventional block tags.
    return $('body').text().replace(/\s+/g, ' ').trim();
  }

  return parts.join('\n\n');
}