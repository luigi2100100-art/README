// Markdown reader and writer. Markdown syntax (#, -, |, **, links) is kept
// intact; only text inside it is copy. Code and raw HTML are not copy.
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { alignValue } from '../align.js';
import { finalize, validateEdits, applyRawChanges, singlePieceChanges } from '../document.js';

export function parseMd(input) {
  const src = typeof input === 'string' ? input : new TextDecoder('utf-8', { ignoreBOM: true }).decode(input);
  const part = 'md';
  const doc = { format: 'md', parts: { [part]: src }, blocks: [], nonCopy: [], warnings: [] };
  const tree = fromMarkdown(src, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  let section = '';
  let images = 0;

  const line = (n) => n.position?.start.line;
  const addText = (b, value, node, kind, editable = true) => {
    const s = node.position.start.offset, e = node.position.end.offset;
    const al = kind === 'text' ? alignValue(src, s, e, 'md', value) : { map: null, editable: false };
    const start = b.text.length;
    b.text += value;
    b.pieces.push({ kind, start, end: b.text.length, rawStart: s, rawEnd: e, map: al.map, editable: editable && al.editable, decode: 'md', valueFromParser: true });
  };
  function inline(node, b) {
    for (const c of node.children || []) {
      switch (c.type) {
        case 'text': addText(b, c.value, c, 'text'); break;
        case 'inlineCode': addText(b, c.value, c, 'code', false); break;
        case 'break': addText(b, '\n', c, 'br', false); break;
        case 'html': doc.nonCopy.push({ kind: 'html', text: c.value }); break;
        case 'image': case 'imageReference':
          images++;
          if (c.alt) {
            // Alt text: located between "![" and "]".
            const s = c.position.start.offset + 2;
            const e = src.indexOf(']', s);
            const ab = { part, kind: 'attr', location: `image alt, line ${line(c)}`, text: '', pieces: [], section };
            const al = alignValue(src, s, e, 'md', c.alt);
            ab.text = c.alt;
            ab.pieces.push({ kind: 'text', start: 0, end: c.alt.length, rawStart: s, rawEnd: e, map: al.map, editable: al.editable, decode: 'md', valueFromParser: true });
            doc.blocks.push(ab);
          }
          break;
        case 'footnoteReference': break;
        default: inline(c, b); // emphasis, strong, delete, link, linkReference
      }
    }
  }
  function block(node, kind, location) {
    const b = { part, kind, location, text: '', pieces: [], section };
    inline(node, b);
    if (kind.startsWith('h')) { section = b.text.trim() || section; b.section = section; }
    if (b.pieces.length) doc.blocks.push(b);
  }
  function walk(node, ctx) {
    for (const c of node.children || []) {
      switch (c.type) {
        case 'heading': block(c, 'h' + c.depth, `heading, line ${line(c)}`); break;
        case 'paragraph': block(c, ctx.list ? 'li' : ctx.quote ? 'quote' : 'p', `${ctx.list ? 'list item' : ctx.quote ? 'quote' : 'paragraph'}, line ${line(c)}`); break;
        case 'table':
          c.children.forEach((row, r) => row.children.forEach((cell, k) => block(cell, 'cell', `table line ${line(c)}, row ${r + 1}, cell ${k + 1}`)));
          break;
        case 'list': walk(c, { ...ctx, list: true }); break;
        case 'listItem': walk(c, ctx); break;
        case 'blockquote': walk(c, { ...ctx, quote: true }); break;
        case 'code': doc.nonCopy.push({ kind: 'code', text: c.value }); break;
        case 'html': doc.nonCopy.push({ kind: 'html', text: c.value }); break;
        case 'yaml': case 'toml': doc.nonCopy.push({ kind: 'front matter', text: c.value }); break;
        case 'footnoteDefinition': walk(c, ctx); break;
        default: if (c.children) walk(c, ctx);
      }
    }
  }
  walk(tree, {});
  if (images) doc.warnings.push(`${images} image(s) found. Alt text is checked; text inside images is not.`);
  return finalize(doc);
}

function encodeMd(text, piece, block) {
  let s = text.replace(/[\\`*_[\]<>]/g, (c) => '\\' + c).replace(/&(?=[#A-Za-z0-9]+;)/g, '&amp;');
  if (block.kind === 'cell') s = s.replace(/\|/g, '\\|');
  // Never let a replacement start block syntax (heading, list, quote).
  s = s.replace(/^([#>+-]|\d+[.)])/, (m) => (m.length === 1 ? '\\' + m : m.slice(0, -1) + '\\' + m.slice(-1)));
  return s;
}

export function writeMd(doc, edits) {
  validateEdits(doc, edits);
  const rawChanges = singlePieceChanges(doc, edits, encodeMd).map((c) => ({ ...c, editIds: [c.editId] }));
  const parts = applyRawChanges(doc.parts, rawChanges);
  return { text: parts.md, bytes: new TextEncoder().encode(parts.md), rawChanges, parts };
}

export const mdDecode = 'md';
