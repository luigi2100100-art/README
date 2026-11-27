import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { intake, parseDocument } from '../src/index.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function load(rel) {
  const p = path.join(ROOT, rel);
  return parseDocument(intake({ name: path.basename(p), bytes: fs.readFileSync(p) }));
}

export function allTestFiles() {
  const out = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'tests/clean'))) if (f.endsWith('.docx')) out.push(`tests/clean/${f}`);
  for (const d of fs.readdirSync(path.join(ROOT, 'tests/seeded'))) {
    if (fs.existsSync(path.join(ROOT, 'tests/seeded', d, 'document.docx'))) out.push(`tests/seeded/${d}/document.docx`);
  }
  for (const f of fs.readdirSync(path.join(ROOT, 'tests/format'))) if (/\.(docx|xlsx|html|md)$/.test(f)) out.push(`tests/format/${f}`);
  return out.sort();
}

/** Make an edit that replaces `find` (first occurrence) in the first block containing it. */
export function editFor(doc, find, after, id = 'E1', { nth = 0 } = {}) {
  const blocks = doc.blocks.filter((b) => b.text.includes(find));
  const b = blocks[nth];
  if (!b) throw new Error(`not found: ${find}`);
  const start = b.text.indexOf(find);
  return { id, blockId: b.id, start, end: start + find.length, before: find, after };
}

let soffice;
export function libreOffice() {
  if (soffice === undefined) {
    try { soffice = execFileSync('sh', ['-c', 'command -v soffice || command -v libreoffice']).toString().trim() || null; } catch { soffice = null; }
  }
  return soffice;
}

/** True if LibreOffice can open the file and convert it to text. */
export function opensInLibreOffice(bytes, ext) {
  const bin = libreOffice();
  if (!bin) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-'));
  const file = path.join(dir, `out.${ext}`);
  fs.writeFileSync(file, bytes);
  const fmt = ext === 'xlsx' ? 'csv' : 'txt:Text';
  try { execFileSync(bin, ['--headless', '--convert-to', fmt, '--outdir', path.join(dir, 'o'), file], { stdio: 'ignore', timeout: 120000 }); } catch { /* checked below */ }
  const outDir = path.join(dir, 'o');
  const ok = fs.existsSync(outDir) && fs.readdirSync(outDir).some((f) => fs.statSync(path.join(outDir, f)).size > 0);
  const content = ok ? fs.readFileSync(path.join(outDir, fs.readdirSync(outDir)[0]), 'utf8') : '';
  fs.rmSync(dir, { recursive: true, force: true });
  return ok ? content : false;
}
