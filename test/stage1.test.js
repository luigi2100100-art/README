// Stage 0 intake and Stage 1 parse/segment gate on the whole test set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, load, allTestFiles } from './helpers.js';
import { intake, parseDocument, IntakeError, GateError } from '../src/index.js';
import { checkGate } from '../src/document.js';
import { sentenceRanges } from '../src/segment.js';
import { reassembleText } from '../src/formats/text.js';

test('every test-set file passes the Stage 1 gate', () => {
  const files = allTestFiles();
  assert.ok(files.length >= 46, `expected the full test set, found ${files.length} files`);
  for (const f of files) {
    const doc = load(f);
    assert.ok(doc.units.length > 0, `${f} has no units`);
  }
});

test('pasted text reassembles exactly, including odd spacing and Windows line endings', () => {
  const samples = [
    'One line only',
    '  Leading spaces.\r\n\r\nSecond paragraph.  Two spaces.\n\n\n\nThird after many blank lines.\n',
    'Kreider et al. (2017) reports this. E.g. that. U.S. FDA rules apply.\n \t\nEnd',
    load('tests/clean/Landing Page V8.7.docx').blocks.map((b) => b.text).join('\n\n'),
  ];
  for (const s of samples) {
    const doc = parseDocument(intake({ text: s }));
    assert.equal(reassembleText(doc), s);
    assert.equal(doc.units.map((u) => u.text).join(''), doc.blocks.map((b) => b.text).join(''));
  }
});

test('the gate stops the run when units or pieces do not match the source', () => {
  const doc = load('tests/clean/Landing Page V8.7.docx');
  // 1. A unit whose text was altered.
  const d1 = structuredClone({ ...doc, entries: undefined, blockById: undefined });
  d1.blockById = Object.fromEntries(d1.blocks.map((b) => [b.id, b]));
  d1.units[5].text = d1.units[5].text.replace(/e/, 'E');
  assert.equal(checkGate(d1, 'xml').ok, false);
  // 2. A source part that no longer matches the extracted text.
  const d2 = structuredClone({ ...doc, entries: undefined, blockById: undefined });
  const b2 = d2.blocks.find((b) => b.text.length > 20);
  const p = b2.pieces.find((x) => x.map);
  d2.parts[b2.part] = d2.parts[b2.part].slice(0, p.rawStart) + 'X' + d2.parts[b2.part].slice(p.rawStart + 1);
  assert.equal(checkGate(d2, 'xml').ok, false);
  // 3. A block whose pieces leave a gap.
  const d3 = structuredClone({ ...doc, entries: undefined, blockById: undefined });
  d3.blocks.find((b) => b.text.length > 20).pieces[0].start = 1;
  assert.equal(checkGate(d3, 'xml').ok, false);
});

test('GateError explains the stop in plain language', () => {
  const e = new GateError(['Body paragraph 4: units do not reassemble the paragraph']);
  assert.match(e.message, /run stopped\. Nothing was changed/);
});

test('intake accepts the listed formats and rejects others with a clear message', () => {
  const docx = fs.readFileSync(path.join(ROOT, 'tests/clean/Landing Page V8.7.docx'));
  assert.equal(intake({ name: 'a.docx', bytes: docx }).format, 'docx');
  assert.match(intake({ name: 'a.docx', bytes: docx }).sha256, /^[0-9a-f]{64}$/);
  assert.throws(() => intake({ name: 'brief.pdf', bytes: new Uint8Array([1]) }), (e) => e instanceof IntakeError && /paste it instead/.test(e.message));
  assert.throws(() => intake({ name: 'old.doc', bytes: new Uint8Array([1]) }), /Save it as .docx/);
  assert.throws(() => intake({ name: 'empty.md', bytes: new Uint8Array() }), /is empty/);
  assert.throws(() => intake({ name: 'fake.docx', bytes: new TextEncoder().encode('hello') }), /not a real Word file/);
  assert.throws(() => intake({ name: 'big.txt', bytes: new Uint8Array(10 * 1024 * 1024 + 1) }), /10 MB/);
  assert.throws(() => intake({ text: '   ' }), /empty/);
  const broken = docx.subarray(0, 3000);
  assert.throws(() => parseDocument(intake({ name: 'broken.docx', bytes: broken })), /could not be read/);
});

test('units carry an id, location, section and offset', () => {
  const doc = load('tests/format/omega3_landing.docx');
  const u = doc.units.find((x) => x.text.startsWith('480 mg EPA'));
  assert.match(u.id, /^U\d{3,}$/);
  assert.equal(u.section, 'What PeakFuel says about EPA and DHA, in full');
  assert.match(u.location, /^Body paragraph \d+$/);
  assert.equal(doc.canonicalText.slice(u.offset, u.offset + u.text.length), u.text);
  assert.deepEqual(doc.units.map((x) => x.id), doc.units.map((_, i) => 'U' + String(i + 1).padStart(3, '0')));
});

test('sentence splitting keeps citations and abbreviations together', () => {
  const split = (t) => sentenceRanges(t).map(([a, b]) => t.slice(a, b).trim());
  assert.deepEqual(split('No loading phase is established (Calder, 2018; McGlory et al., 2019), so day one is the same. Next.'),
    ['No loading phase is established (Calder, 2018; McGlory et al., 2019), so day one is the same.', 'Next.']);
  assert.deepEqual(split('According to the U.S. Food and Drug Administration, this applies. Kreider et al. (2017) reports X.'),
    ['According to the U.S. Food and Drug Administration, this applies.', 'Kreider et al. (2017) reports X.']);
  assert.deepEqual(split('Use it daily, e.g. with breakfast. Done!'), ['Use it daily, e.g. with breakfast.', 'Done!']);
  const t = ' A. B? C! ';
  assert.equal(sentenceRanges(t).map(([a, b]) => t.slice(a, b)).join(''), t);
});

test('docx: headers, footers, tables and comments are read', () => {
  const doc = load('tests/format/omega3_landing.docx');
  assert.ok(doc.blocks.some((b) => b.location === 'Header 1 paragraph 1' && b.text.includes('Omega-3 landing page copy')));
  assert.ok(doc.blocks.some((b) => b.location.startsWith('Footer 1') && b.text.includes('All rights reserved')));
  assert.ok(doc.blocks.some((b) => b.location === 'Body table 1 row 2 cell 1' && b.text === 'EPA and DHA amounts'));
  const withComments = allTestFiles().filter((f) => f.startsWith('tests/clean')).map(load).filter((d) => d.nonCopy.some((n) => n.kind === 'comment'));
  for (const d of withComments) assert.ok(d.nonCopy.every((n) => n.text));
});
