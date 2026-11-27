// Common document model, units (Stage 1) and the Stage 1 reassembly gate.
import { sentenceRanges } from './segment.js';
import { verifyPiece } from './align.js';

/**
 * Block: one paragraph, cell, heading, attribute value, etc.
 * {
 *   id, part, kind, location, section, text, isCopy,
 *   pieces: [{ start, end, rawStart, rawEnd, map, editable, kind, valueFromParser? , ...format extras }]
 * }
 * Piece offsets (start/end) are positions in block.text. rawStart/rawEnd and map
 * are positions in doc.parts[block.part] (a JS string).
 */

export class GateError extends Error {
  constructor(problems) {
    super('The document could not be split into units safely, so the run stopped. ' +
      'Nothing was changed. Details: ' + problems.slice(0, 5).join('; '));
    this.problems = problems;
  }
}

export class EditRefused extends Error {
  constructor(editId, reason) {
    super(`Edit ${editId} was not applied: ${reason}`);
    this.editId = editId;
    this.reason = reason;
  }
}

/** Number blocks and build sentence-level units. */
export function finalize(doc) {
  const sep = '\n';
  let offset = 0;
  const units = [];
  const parts = [];
  doc.blocks.forEach((b, i) => {
    b.id = 'B' + String(i + 1).padStart(4, '0');
    b.offset = offset;
    parts.push(b.text);
    if (b.text.trim()) {
      for (const [s, e] of sentenceRanges(b.text)) {
        units.push({ blockId: b.id, start: s, end: e, text: b.text.slice(s, e), offset: offset + s,
          section: b.section || '', location: b.location, isCopy: b.isCopy !== false });
      }
    }
    offset += b.text.length + sep.length;
  });
  const width = Math.max(3, String(units.length).length);
  units.forEach((u, i) => { u.id = 'U' + String(i + 1).padStart(width, '0'); });
  doc.units = units;
  doc.canonicalText = parts.join(sep);
  doc.blockById = Object.fromEntries(doc.blocks.map((b) => [b.id, b]));
  return doc;
}

/**
 * Stage 1 gate. Programmatic checks that units reproduce the document text
 * exactly and that every editable piece maps back to the original bytes.
 * Returns { ok, problems }.
 */
export function checkGate(doc, decodeKind, { serializeUnchanged } = {}) {
  const problems = [];
  for (const b of doc.blocks) {
    const raw = doc.parts[b.part];
    // Pieces must tile the block text.
    let pos = 0;
    for (const p of b.pieces) {
      if (p.start !== pos) { problems.push(`${b.location}: gap or overlap in text pieces at ${pos}`); break; }
      if (p.end - p.start !== (p.text ?? b.text.slice(p.start, p.end)).length) problems.push(`${b.location}: piece length mismatch`);
      pos = p.end;
      if (raw === undefined) { problems.push(`${b.location}: unknown part ${b.part}`); continue; }
      if (p.map) {
        const piece = { ...p, text: b.text.slice(p.start, p.end) };
        if (!verifyPiece(raw, piece, p.decode || decodeKind)) problems.push(`${b.location}: text does not match the source at offset ${p.rawStart}`);
      }
    }
    if (pos !== b.text.length) problems.push(`${b.location}: pieces cover ${pos} of ${b.text.length} characters`);
  }
  // Units must reassemble every block exactly, and the whole text.
  const byBlock = {};
  for (const u of doc.units) (byBlock[u.blockId] ||= []).push(u);
  for (const b of doc.blocks) {
    const us = byBlock[b.id] || [];
    const joined = us.map((u) => u.text).join('');
    if (b.text.trim() && joined !== b.text) problems.push(`${b.location}: units do not reassemble the paragraph`);
    let p = 0;
    for (const u of us) {
      if (u.start !== p || doc.canonicalText.slice(u.offset, u.offset + u.text.length) !== u.text) {
        problems.push(`${u.id}: position does not match`);
      }
      p = u.end;
    }
  }
  if (doc.blocks.map((b) => b.text).join('\n') !== doc.canonicalText) problems.push('blocks do not reassemble the document text');
  // Writing the document back with no edits must give the original parts.
  if (serializeUnchanged) {
    const out = serializeUnchanged(doc);
    for (const [name, original] of Object.entries(doc.parts)) {
      if (out[name] !== original) problems.push(`writing back with no changes alters ${name}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/** Validate edits against the parsed document. Throws EditRefused. */
export function validateEdits(doc, edits) {
  const seen = new Set();
  const byBlock = {};
  for (const e of edits) {
    if (!e.id) throw new EditRefused('?', 'every edit needs an id');
    if (seen.has(e.id)) throw new EditRefused(e.id, 'duplicate edit id');
    seen.add(e.id);
    const b = doc.blockById[e.blockId];
    if (!b) throw new EditRefused(e.id, `unknown block ${e.blockId}`);
    if (!(Number.isInteger(e.start) && Number.isInteger(e.end) && e.start >= 0 && e.start <= e.end && e.end <= b.text.length)) {
      throw new EditRefused(e.id, 'position is outside the paragraph');
    }
    if (b.text.slice(e.start, e.end) !== e.before) throw new EditRefused(e.id, 'the text at that position is not the expected "before" text');
    if (typeof e.after !== 'string') throw new EditRefused(e.id, '"after" text is missing');
    if (/[\r\n]/.test(e.after)) throw new EditRefused(e.id, 'line breaks in replacement text are not supported');
    if (e.before === e.after) throw new EditRefused(e.id, 'before and after are identical');
    (byBlock[e.blockId] ||= []).push(e);
  }
  for (const list of Object.values(byBlock)) {
    list.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1], c = list[i];
      if (c.start < a.end || (c.start === a.end && (a.start === a.end || c.start === c.end))) {
        throw new EditRefused(c.id, `overlaps edit ${a.id}`);
      }
    }
  }
  return byBlock;
}

/**
 * For formats where an edit must stay inside one text piece (html, md, xlsx,
 * text). Returns raw changes: [{ part, start, end, text, editId }].
 */
export function singlePieceChanges(doc, edits, encode) {
  const changes = [];
  for (const e of edits) {
    const b = doc.blockById[e.blockId];
    const host = b.pieces.find((p) => p.editable && p.map && p.start <= e.start && e.end <= p.end &&
      // a pure insertion at a boundary belongs to a piece that is editable
      true);
    if (!host) throw new EditRefused(e.id, 'the change crosses formatting or markup, or touches text that cannot be edited safely');
    const a = host.map[e.start - host.start];
    const z = host.map[e.end - host.start];
    if (a === -1 || z === -1) throw new EditRefused(e.id, 'the change starts or ends inside an encoded character');
    changes.push({ part: b.part, start: a, end: z, text: encode(e.after, host, b), editId: e.id });
  }
  return changes;
}

/** Apply raw changes to part strings. Returns a new parts object. */
export function applyRawChanges(parts, changes) {
  const out = { ...parts };
  const byPart = {};
  for (const c of changes) (byPart[c.part] ||= []).push(c);
  for (const [part, list] of Object.entries(byPart)) {
    list.sort((a, b) => b.start - a.start || b.end - a.end);
    let s = out[part];
    let limit = Infinity;
    for (const c of list) {
      if (c.end > limit) throw new Error(`overlapping raw changes in ${part}`);
      s = s.slice(0, c.start) + c.text + s.slice(c.end);
      limit = c.start;
    }
    out[part] = s;
  }
  return out;
}

/** Apply edits to block texts (the intended result), keyed by block id. */
export function intendedTexts(doc, edits) {
  const res = Object.fromEntries(doc.blocks.map((b) => [b.id, b.text]));
  const byBlock = {};
  for (const e of edits) (byBlock[e.blockId] ||= []).push(e);
  for (const [id, list] of Object.entries(byBlock)) {
    list.sort((a, b) => b.start - a.start);
    let t = res[id];
    for (const e of list) t = t.slice(0, e.start) + e.after + t.slice(e.end);
    res[id] = t;
  }
  return res;
}
