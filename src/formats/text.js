// Pasted text. Paragraphs are separated by blank lines.
import { finalize, validateEdits, applyRawChanges, singlePieceChanges } from '../document.js';
import { decodeWithMap } from '../align.js';

export function parseText(input) {
  const src = typeof input === 'string' ? input : new TextDecoder('utf-8', { ignoreBOM: true }).decode(input);
  const part = 'text';
  const doc = { format: 'text', parts: { [part]: src }, blocks: [], nonCopy: [], warnings: [] };
  const re = /\r?\n[ \t]*\r?\n(?:[ \t]*\r?\n)*/g;
  let pos = 0;
  let n = 0;
  const add = (s, e) => {
    if (e <= s || !src.slice(s, e).trim()) return;
    n++;
    const d = decodeWithMap(src, s, e, 'none');
    doc.blocks.push({ part, kind: 'p', location: `paragraph ${n}`, section: '', text: d.text,
      pieces: [{ kind: 'text', start: 0, end: d.text.length, rawStart: s, rawEnd: e, map: d.map, editable: true, decode: 'none' }] });
  };
  for (const m of src.matchAll(re)) { add(pos, m.index); pos = m.index + m[0].length; }
  add(pos, src.length);
  return finalize(doc);
}

/** Pasted text has no markup, so unit gaps plus units must give the input back exactly. */
export function reassembleText(doc) {
  const src = doc.parts.text;
  let out = '';
  let pos = 0;
  for (const b of doc.blocks) {
    const p = b.pieces[0];
    out += src.slice(pos, p.rawStart);
    out += doc.units.filter((u) => u.blockId === b.id).map((u) => u.text).join('');
    pos = p.rawEnd;
  }
  return out + src.slice(pos);
}

export function writeText(doc, edits) {
  validateEdits(doc, edits);
  const rawChanges = singlePieceChanges(doc, edits, (t) => t).map((c) => ({ ...c, editIds: [c.editId] }));
  const parts = applyRawChanges(doc.parts, rawChanges);
  return { text: parts.text, bytes: new TextEncoder().encode(parts.text), rawChanges, parts };
}

export const textDecode = 'none';
