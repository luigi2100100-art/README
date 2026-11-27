// Format set (tests/format/expected.json): each parser finds the same copy,
// and ignores what is not copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, load } from './helpers.js';

const expected = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/format/expected.json'), 'utf8'));
const norm = (s) => s.replace(/\s+/g, ' ').trim();

for (const name of Object.keys(expected.files)) {
  test(`${name}: every copy text from the landing page is found`, () => {
    const doc = load(`tests/format/${name}`);
    const blocks = doc.blocks.filter((b) => b.isCopy !== false).map((b) => norm(b.text));
    const all = blocks.join('\n');
    const missing = expected.copy_texts.filter((t) => !all.includes(norm(t)));
    assert.deepEqual(missing, []);
  });
}

test('docx: header and footer are copy units', () => {
  const doc = load('tests/format/omega3_landing.docx');
  for (const t of expected.files['omega3_landing.docx'].must_include_as_copy) assert.ok(doc.blocks.some((b) => b.text === t), t);
});

test('html: attributes, title and buttons are copy; script, style, comments and hidden text are not', () => {
  const doc = load('tests/format/omega3_landing.html');
  const texts = doc.blocks.map((b) => norm(b.text));
  for (const t of expected.files['omega3_landing.html'].must_include_as_copy) assert.ok(texts.includes(norm(t)), `missing copy: ${t}`);
  const all = doc.canonicalText;
  for (const t of expected.files['omega3_landing.html'].must_exclude_from_copy) assert.ok(!all.includes(t), `should not be copy: ${t}`);
  const kinds = new Set(doc.nonCopy.map((n) => n.kind));
  for (const k of ['script', 'style', 'comment', 'hidden']) assert.ok(kinds.has(k), `nonCopy should record ${k}`);
  // The H1 is split across two <span>s but reads as one word.
  assert.equal(doc.blocks.find((b) => b.kind === 'h1').text, 'PeakFuel Omega-3');
});

test('xlsx: copy column is found, labels and notes are not copy, formulas and numbers are listed', () => {
  const doc = load('tests/format/omega3_landing.xlsx');
  assert.deepEqual(doc.columns['Landing page'].suggested, ['C']);
  assert.equal(doc.columns['Landing page'].ambiguous, false);
  assert.deepEqual(doc.columns.Pricing.suggested, []);
  assert.equal(doc.columns.Pricing.ambiguous, true);
  assert.ok(doc.warnings.some((w) => w.includes('confirm which columns hold copy on: Pricing')));
  for (const b of doc.blocks) {
    const copy = b.sheet === 'Landing page' && /^C\d+$/.test(b.ref) && b.ref !== 'C1';
    assert.equal(b.isCopy, copy, b.location);
  }
  assert.ok(doc.otherCells.some((c) => c.address === "'Landing page'!D2" && c.kind === 'formula'));
  assert.ok(doc.otherCells.some((c) => c.address === "'Pricing'!C2" && c.kind === 'formula'));
  assert.ok(doc.otherCells.some((c) => c.address === "'Pricing'!B2" && c.kind === 'number'));
  assert.equal(doc.blocks.find((b) => b.ref === 'C2').location, "'Landing page'!C2");
});

test('xlsx: the client\'s answer about copy columns overrides the guess', async () => {
  const { parseXlsx } = await import('../src/formats/xlsx.js');
  const bytes = fs.readFileSync(path.join(ROOT, 'tests/format/omega3_landing.xlsx'));
  const doc = parseXlsx(bytes, { copyColumns: { Pricing: ['A'] } });
  assert.ok(doc.blocks.find((b) => b.location === "'Pricing'!A2").isCopy);
  assert.ok(!doc.warnings.some((w) => w.includes('Pricing')));
});

test('md: code and html are not copy, table cells are', () => {
  const doc = load('tests/format/omega3_landing.md');
  assert.ok(doc.blocks.some((b) => b.kind === 'cell' && b.text === 'EPA and DHA amounts'));
  assert.ok(doc.blocks.some((b) => b.kind === 'h1' && b.text === 'PeakFuel Omega-3'));
});
