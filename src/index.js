// Stage 0 (intake), Stage 1 (parse, segment, gate) and the writers with the
// format round-trip check. No AI is involved in any of this.
import { createHash } from 'node:crypto';
import { parseDocx, writeDocx } from './formats/docx.js';
import { parseXlsx, writeXlsx } from './formats/xlsx.js';
import { parseHtml, writeHtml } from './formats/html.js';
import { parseMd, writeMd } from './formats/md.js';
import { parseText, writeText, reassembleText } from './formats/text.js';
import { checkGate, GateError, intendedTexts } from './document.js';
import { readZip, sameBytes } from './zip.js';

export const MAX_BYTES = 10 * 1024 * 1024;

const FORMATS = {
  docx: { parse: parseDocx, write: writeDocx, decode: 'xml', zip: true },
  xlsx: { parse: parseXlsx, write: writeXlsx, decode: 'xml', zip: true },
  html: { parse: parseHtml, write: writeHtml, decode: 'html' },
  md: { parse: parseMd, write: writeMd, decode: 'md' },
  text: { parse: parseText, write: writeText, decode: 'none' },
};

const EXT = { docx: 'docx', xlsx: 'xlsx', html: 'html', htm: 'html', md: 'md', markdown: 'md', txt: 'text' };

export class IntakeError extends Error {}

/**
 * Stage 0. input: { name, bytes } for a file, or { text } for pasted text.
 * Returns { format, sha256, size, bytes|text }.
 */
export function intake(input) {
  if (typeof input.text === 'string') {
    if (!input.text.trim()) throw new IntakeError('The pasted text is empty.');
    const bytes = new TextEncoder().encode(input.text);
    if (bytes.length > MAX_BYTES) throw new IntakeError('The pasted text is too long (limit 10 MB).');
    return { format: 'text', sha256: sha256(bytes), size: bytes.length, text: input.text, name: input.name || 'pasted text' };
  }
  const name = input.name || '';
  const ext = (/\.([A-Za-z0-9]+)$/.exec(name)?.[1] || '').toLowerCase();
  const format = EXT[ext];
  if (!format) {
    const hint = ext === 'doc' ? ' Save it as .docx first.' : ext === 'xls' ? ' Save it as .xlsx first.' : ext === 'pdf' ? ' Copy the text and paste it instead.' : '';
    throw new IntakeError(`"${name}" can't be checked. Accepted files: .docx, .xlsx, .html, .md, .txt, or pasted text.${hint}`);
  }
  const bytes = input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes);
  if (!bytes.length) throw new IntakeError(`"${name}" is empty.`);
  if (bytes.length > MAX_BYTES) throw new IntakeError(`"${name}" is larger than the 10 MB limit.`);
  if (FORMATS[format].zip && !(bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    throw new IntakeError(`"${name}" is not a real ${format === 'docx' ? 'Word' : 'Excel'} file. It may be damaged or renamed.`);
  }
  return { format, sha256: sha256(bytes), size: bytes.length, bytes, name };
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Stage 1: parse, segment into units, and run the gate. Throws GateError. */
export function parseDocument(item, opts = {}) {
  const f = FORMATS[item.format];
  let doc;
  try {
    doc = f.parse(item.format === 'text' ? item.text : item.bytes, opts);
  } catch (e) {
    if (e instanceof GateError) throw e;
    throw new IntakeError(`"${item.name}" could not be read: ${e.message}`);
  }
  const gate = checkGate(doc, f.decode, { serializeUnchanged: (d) => d.parts });
  if (item.format === 'text' && reassembleText(doc) !== item.text) gate.problems.push('units do not reassemble the pasted text');
  if (f.zip) {
    // Writing with no edits must give every zip entry back unchanged.
    const out = f.write(doc, []);
    const again = readZip(out.bytes);
    for (const [name, data] of Object.entries(doc.entries)) {
      if (!sameBytes(again[name], data)) gate.problems.push(`writing back with no changes alters ${name}`);
    }
  }
  if (gate.problems.length) throw new GateError(gate.problems);
  if (!doc.units.length) doc.warnings.push('No text was found to check.');
  doc.sourceName = item.name;
  doc.sha256 = item.sha256;
  return doc;
}

/**
 * Apply edits and run the format round-trip check (Stage 7.7, plus the
 * byte-level part of 7.1). Returns { bytes, text?, check }.
 */
export function writeDocument(doc, edits, opts = {}) {
  const f = FORMATS[doc.format];
  const out = f.write(doc, edits, opts);
  const check = roundTrip(doc, edits, out);
  return { ...out, check };
}

export function roundTrip(doc, edits, out) {
  const f = FORMATS[doc.format];
  const problems = [];
  // 1. Every byte change must come from a logged raw change.
  for (const [name, original] of Object.entries(doc.parts)) {
    const mine = out.rawChanges.filter((c) => c.part === name);
    let s = original;
    for (const c of [...mine].sort((a, b) => b.start - a.start)) s = s.slice(0, c.start) + c.text + s.slice(c.end);
    if (s !== out.parts[name]) problems.push(`${name} has changes that are not in the log`);
  }
  // 2. Parts that weren't edited are byte-identical (zip formats).
  let reparsed;
  if (f.zip) {
    const entries = readZip(out.bytes);
    const allowed = new Set([...Object.keys(doc.parts).filter((n) => out.parts[n] !== doc.parts[n]), ...Object.keys(out.extraParts || {})]);
    for (const [name, data] of Object.entries(doc.entries)) {
      if (!allowed.has(name) && !sameBytes(entries[name], data)) problems.push(`${name} changed but was not edited`);
    }
    for (const name of Object.keys(entries)) if (!(name in doc.entries) && !allowed.has(name)) problems.push(`unexpected new file ${name}`);
  }
  // 3. The output opens and reads as intended.
  try {
    reparsed = f.parse(f.zip ? out.bytes : out.text);
  } catch (e) {
    problems.push(`the output file does not open: ${e.message}`);
    return { ok: false, problems };
  }
  const gate = checkGate(reparsed, f.decode);
  problems.push(...gate.problems.map((p) => `output: ${p}`));
  const want = intendedTexts(doc, edits);
  if (reparsed.blocks.length !== doc.blocks.length) {
    problems.push(`output has ${reparsed.blocks.length} paragraphs/cells, expected ${doc.blocks.length}`);
  } else {
    doc.blocks.forEach((b, i) => {
      if (reparsed.blocks[i].text !== want[b.id]) problems.push(`${b.location}: output text is not the intended text`);
    });
  }
  // 4. Word only: rejecting all tracked changes gives the original text back.
  if (doc.format === 'docx') {
    const original = f.parse(out.bytes, { view: 'rejected' });
    const before = doc.view === 'accepted' && !doc.warnings.some((w) => w.includes('tracked changes')) ? doc.blocks.map((b) => b.text) : null;
    if (before) {
      const got = original.blocks.map((b) => b.text);
      if (got.length !== before.length || got.some((t, i) => t !== before[i])) problems.push('rejecting the tracked changes does not give back the original text');
    }
  }
  return { ok: problems.length === 0, problems };
}

export { GateError };
export { EditRefused } from './document.js';
