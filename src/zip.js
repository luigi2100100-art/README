// Zip container helpers (.docx and .xlsx are zip files).
import { unzipSync, zipSync } from 'fflate';

const dec = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const enc = new TextEncoder();

export function readZip(bytes) {
  let entries;
  try {
    entries = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  } catch {
    throw new Error('The file could not be opened. It may be damaged or not a real Office file.');
  }
  return entries;
}

export function text(entries, name) {
  const e = entries[name];
  return e ? dec.decode(e) : undefined;
}

/** Copy entries, replacing the given text parts. Keeps entry order. */
export function writeZip(entries, replaceText = {}) {
  const out = {};
  for (const [name, data] of Object.entries(entries)) {
    out[name] = name in replaceText ? enc.encode(replaceText[name]) : data;
  }
  for (const [name, t] of Object.entries(replaceText)) if (!(name in out)) out[name] = enc.encode(t);
  return zipSync(out, { level: 6 });
}

export function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
