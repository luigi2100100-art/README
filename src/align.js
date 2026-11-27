// Text pieces: a run of decoded text with a map back to the raw source.
// map[k] is the raw offset where decoded char k starts (map[len] = raw end).
// A value of -1 marks a position inside one raw token (an entity or escape),
// where an edit may not start or end.
import { decodeHTMLStrict } from 'entities';
import { xmlEntity } from './xml.js';

const ENT_RE = /^&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{0,31});/;
const ASCII_PUNCT = /[!-\/:-@\[-`{-~]/;

/**
 * Decode raw[start:end) and build the offset map.
 * kind: 'xml' | 'html' | 'md' | 'none'
 */
export function decodeWithMap(raw, start, end, kind) {
  let text = '';
  const map = [];
  let i = start;
  const push = (s, at) => {
    for (let k = 0; k < s.length; k++) map.push(k === 0 ? at : -1);
    text += s;
  };
  while (i < end) {
    const c = raw[i];
    if (c === '&' && kind !== 'none') {
      const m = ENT_RE.exec(raw.slice(i, Math.min(end, i + 40)));
      if (m) {
        const v = kind === 'xml' ? xmlEntity(m[1]) : decodeHTMLStrict(m[0]);
        if (v !== null && v !== m[0]) { push(v, i); i += m[0].length; continue; }
      }
    }
    if (c === '\r' && raw[i + 1] === '\n' && (kind === 'html' || kind === 'md')) { push('\n', i); i += 2; continue; }
    if (c === '\\' && kind === 'md' && i + 1 < end && ASCII_PUNCT.test(raw[i + 1])) { push(raw[i + 1], i); i += 2; continue; }
    const code = c.charCodeAt(0);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < end) { push(c + raw[i + 1], i); i += 2; continue; }
    push(c, i);
    i++;
  }
  map.push(end);
  return { text, map };
}

/**
 * Align a parser-supplied value (e.g. from parse5 or mdast) with the raw slice.
 * Returns {text, map, editable}. editable is false when the parser dropped raw
 * characters inside the value (e.g. markdown line prefixes) or when the value
 * could not be aligned at all (then map is null).
 */
export function alignValue(raw, start, end, kind, value) {
  const d = decodeWithMap(raw, start, end, kind);
  if (d.text === value) return { text: value, map: d.map, editable: true };
  const map = [];
  let j = 0;
  let skipped = false;
  for (let i = 0; i < value.length; i++) {
    while (j < d.text.length && d.text[j] !== value[i] && ' \t>'.includes(d.text[j])) { j++; skipped = true; }
    if (d.text[j] !== value[i]) return { text: value, map: null, editable: false };
    map.push(d.map[j]);
    j++;
  }
  if (!/^[ \t\n>]*$/.test(d.text.slice(j))) return { text: value, map: null, editable: false };
  map.push(j < d.text.length ? d.map[j] : end);
  return { text: value, map, editable: !skipped };
}

/** Check a piece against its source. Used by the Stage 1 gate. */
export function verifyPiece(raw, piece, kind) {
  if (!piece.map) return true; // non-editable piece trusted from the parser; never edited
  const d = piece.valueFromParser
    ? alignValue(raw, piece.rawStart, piece.rawEnd, kind, piece.text)
    : decodeWithMap(raw, piece.rawStart, piece.rawEnd, kind);
  if (d.text !== piece.text || !d.map) return false;
  if (d.map.length !== piece.map.length) return false;
  return d.map.every((v, k) => v === piece.map[k]);
}
