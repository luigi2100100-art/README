// .html reader and writer. Text nodes and copy-bearing attributes are units.
// Scripts, styles, comments, templates and hidden elements are not copy.
// Tags and other attributes are never edited.
import { parse } from 'parse5';
import { alignValue, decodeWithMap } from '../align.js';
import { finalize, validateEdits, applyRawChanges, singlePieceChanges } from '../document.js';

const BLOCK = new Set(('address article aside blockquote body button caption dd details dialog div dl dt fieldset figcaption figure footer ' +
  'form h1 h2 h3 h4 h5 h6 header hgroup hr html legend li main nav ol optgroup option p pre section select summary table tbody td ' +
  'textarea tfoot th thead title tr ul').split(' '));
const SKIP = new Set(['script', 'style', 'template', 'noscript', 'svg', 'math', 'iframe', 'object', 'head']);
const COPY_ATTRS = ['alt', 'title', 'aria-label', 'placeholder'];
const META_COPY = /^(description|og:title|og:description|twitter:title|twitter:description)$/i;

function attrOf(el, name) {
  return el.attrs?.find((a) => a.name === name)?.value;
}

function isHidden(el) {
  if (!el.attrs) return false;
  if (el.attrs.some((a) => a.name === 'hidden')) return true;
  if (attrOf(el, 'aria-hidden') === 'true') return false; // still visible on screen
  const style = (attrOf(el, 'style') || '').replace(/\s+/g, '').toLowerCase();
  return /display:none|visibility:hidden/.test(style);
}

/** Raw range of an attribute's value, from parse5's location of the whole attribute. */
function attrValueRange(src, loc) {
  const raw = src.slice(loc.startOffset, loc.endOffset);
  const eq = raw.indexOf('=');
  if (eq === -1) return null;
  let i = eq + 1;
  while (/\s/.test(raw[i])) i++;
  const q = raw[i];
  if (q === '"' || q === "'") {
    const end = raw.lastIndexOf(q);
    return end > i ? { start: loc.startOffset + i + 1, end: loc.startOffset + end, quote: q } : null;
  }
  return { start: loc.startOffset + i, end: loc.endOffset, quote: '' };
}

export function parseHtml(input) {
  const src = typeof input === 'string' ? input : new TextDecoder('utf-8', { ignoreBOM: true }).decode(input);
  const part = 'html';
  const doc = { format: 'html', parts: { [part]: src }, blocks: [], nonCopy: [], warnings: [] };
  const tree = parse(src, { sourceCodeLocationInfo: true });
  let section = '';
  let images = 0;
  const counters = {};

  const newBlock = (el, kind) => {
    const tag = el.tagName;
    counters[tag] = (counters[tag] || 0) + 1;
    return { part, kind, tag, location: `<${tag}> #${counters[tag]}`, text: '', pieces: [], section };
  };
  const flush = (b) => {
    if (!b || !b.pieces.length) return;
    if (/^h[1-3]$/.test(b.tag) && b.text.trim()) section = b.text.trim().replace(/\s+/g, ' ');
    b.section = /^h[1-3]$/.test(b.tag) ? section : b.section;
    doc.blocks.push(b);
  };
  const addAttrBlock = (el, name, kind) => {
    const loc = el.sourceCodeLocation?.attrs?.[name];
    const value = attrOf(el, name);
    if (!loc || value === undefined || !value.trim()) return;
    const r = attrValueRange(src, loc);
    const b = { part, kind, tag: el.tagName, location: `<${el.tagName} ${name}>`, text: value, pieces: [], section };
    const al = r ? alignValue(src, r.start, r.end, 'html', value) : { map: null, editable: false };
    b.pieces.push({ kind: 'attr', start: 0, end: value.length, rawStart: r?.start, rawEnd: r?.end, map: al.map, editable: al.editable && !!r && r.quote !== '', decode: 'html', valueFromParser: true, quote: r?.quote });
    doc.blocks.push(b);
  };

  function walk(node, ctx) {
    for (const child of node.childNodes || []) {
      if (child.nodeName === '#comment') { doc.nonCopy.push({ kind: 'comment', text: child.data }); continue; }
      if (child.nodeName === '#text') {
        const block = ctx.block;
        if (!block) continue;
        const loc = child.sourceCodeLocation;
        if (!loc) continue;
        const al = alignValue(src, loc.startOffset, loc.endOffset, 'html', child.value);
        const start = block.text.length;
        block.text += child.value;
        block.pieces.push({ kind: 'text', start, end: block.text.length, rawStart: loc.startOffset, rawEnd: loc.endOffset, map: al.map, editable: al.editable, decode: 'html', valueFromParser: true });
        continue;
      }
      if (!child.tagName) continue;
      const tag = child.tagName;
      if (tag === 'head') { walkHead(child); continue; }
      if (SKIP.has(tag)) {
        const text = src.slice(child.sourceCodeLocation?.startOffset ?? 0, child.sourceCodeLocation?.endOffset ?? 0);
        if (tag === 'script' || tag === 'style' || tag === 'noscript') doc.nonCopy.push({ kind: tag, text });
        continue;
      }
      if (isHidden(child)) {
        const text = src.slice(child.sourceCodeLocation?.startOffset ?? 0, child.sourceCodeLocation?.endOffset ?? 0);
        doc.nonCopy.push({ kind: 'hidden', text });
        doc.warnings.push(`Hidden content in <${tag}> is not checked as copy.`);
        continue;
      }
      if (tag === 'img') images++;
      for (const a of COPY_ATTRS) addAttrBlock(child, a, 'attr');
      if (tag === 'input' && /^(submit|button|reset)$/i.test(attrOf(child, 'type') || '')) addAttrBlock(child, 'value', 'attr');
      if (tag === 'br' && ctx.block) {
        const block = ctx.block;
        const loc = child.sourceCodeLocation;
        const start = block.text.length;
        block.text += '\n';
        block.pieces.push({ kind: 'br', start, end: start + 1, rawStart: loc?.startOffset, rawEnd: loc?.endOffset, map: null, editable: false });
        continue;
      }
      if (BLOCK.has(tag)) {
        flush(ctx.block);
        const b = newBlock(child, /^h\d$/.test(tag) ? tag : tag === 'li' ? 'li' : /^t[dh]$/.test(tag) ? 'cell' : tag === 'button' ? 'button' : 'p');
        const inner = { block: b };
        walk(child, inner);
        flush(inner.block);
        // Text after a nested block continues in a fresh block of the parent.
        if (ctx.block) {
          const prev = ctx.block;
          ctx.block = { ...prev, text: '', pieces: [], location: prev.location.replace(/ \(continued\)$/, '') + ' (continued)', section };
        }
      } else {
        walk(child, ctx);
      }
    }
  }
  function walkHead(head) {
    for (const el of head.childNodes || []) {
      if (el.nodeName === '#comment') { doc.nonCopy.push({ kind: 'comment', text: el.data }); continue; }
      if (el.tagName === 'title') { const c = { block: newBlock(el, 'title') }; walk(el, c); flush(c.block); }
      if (el.tagName === 'meta' && META_COPY.test(attrOf(el, 'name') || attrOf(el, 'property') || '')) addAttrBlock(el, 'content', 'meta');
      if (el.tagName === 'script' || el.tagName === 'style') doc.nonCopy.push({ kind: el.tagName, text: src.slice(el.sourceCodeLocation.startOffset, el.sourceCodeLocation.endOffset) });
    }
  }
  const html = tree.childNodes.find((n) => n.tagName === 'html');
  const root = { block: { part, kind: 'p', tag: 'body', location: '<body>', text: '', pieces: [], section: '' } };
  walk(html || tree, root);
  flush(root.block);
  // Blocks that are only whitespace carry no copy.
  doc.blocks = doc.blocks.filter((b) => b.text.trim());
  if (images) doc.warnings.push(`${images} image(s) found. Alt text is checked; text inside images is not.`);
  return finalize(doc);
}

function encodeHtml(text, piece) {
  let s = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (piece.kind === 'attr') s = piece.quote === "'" ? s.replace(/'/g, '&#39;') : s.replace(/"/g, '&quot;');
  return s;
}

export function writeHtml(doc, edits) {
  validateEdits(doc, edits);
  const rawChanges = singlePieceChanges(doc, edits, encodeHtml).map((c) => ({ ...c, editIds: [c.editId] }));
  const parts = applyRawChanges(doc.parts, rawChanges);
  return { text: parts.html, bytes: new TextEncoder().encode(parts.html), rawChanges, parts };
}

export const htmlDecode = 'html';
export { decodeWithMap };
