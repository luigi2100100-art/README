// Writers and the format round-trip check: edits change only what they say,
// everything else stays byte-identical, and the output opens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { ROOT, load, editFor, opensInLibreOffice, libreOffice } from './helpers.js';
import { intake, parseDocument, writeDocument, EditRefused } from '../src/index.js';
import { parseDocx } from '../src/formats/docx.js';
import { parseXlsx } from '../src/formats/xlsx.js';

const DATE = { date: '2026-01-01T00:00:00Z' };
const stats = { outputs: 0, reopenFailures: 0, unloggedChanges: 0 };
function written(doc, edits, ext, opts) {
  const out = writeDocument(doc, edits, opts);
  stats.outputs++;
  if (!out.check.ok) {
    stats.unloggedChanges += out.check.problems.filter((p) => /not in the log|not edited/.test(p)).length;
    assert.fail(out.check.problems.join('\n'));
  }
  if (ext && libreOffice()) {
    const content = opensInLibreOffice(out.bytes, ext);
    if (content === false) stats.reopenFailures++;
    assert.notEqual(content, false, 'output does not open in LibreOffice');
  }
  return out;
}

// ---------------------------------------------------------------- docx

test('docx: replacement is a tracked change; rejecting it restores the original', () => {
  const doc = load('tests/seeded/omega3-02-cures/document.docx');
  const e = editFor(doc, 'cures dry eye in as little as two weeks', 'provides EPA and DHA');
  const out = written(doc, [e], 'docx', DATE);
  const xml = Buffer.from(out.parts['word/document.xml']).toString();
  assert.match(xml, /<w:del w:id="\d+" w:author="Compliance Review Tool" w:date="2026-01-01T00:00:00Z">/);
  assert.match(xml, /<w:delText xml:space="preserve">cures dry eye in as little as two weeks<\/w:delText>/);
  assert.match(xml, /<w:ins [^>]*><w:r><w:rPr>[\s\S]*?<\/w:rPr><w:t xml:space="preserve">provides EPA and DHA<\/w:t>/);
  const accepted = parseDocx(out.bytes);
  assert.equal(accepted.blockById[e.blockId].text, 'People with dry eye. PeakFuel Omega-3 provides EPA and DHA.');
});

test('docx: an edit across formatting runs keeps each run\'s formatting', () => {
  const doc = load('tests/clean/Copy of PeakFuel Omega-3 Landing Page V10.docx');
  const b = doc.blocks.find((x) => x.text.startsWith('Loading: none.'));
  assert.ok(b.pieces.filter((p) => p.kind === 'text').length >= 3);
  const e = editFor(doc, 'none. No loading phase', 'none. No loading period');
  const out = written(doc, [e], 'docx', DATE);
  const again = parseDocx(out.bytes);
  assert.ok(again.blockById[b.id].text.startsWith('Loading: none. No loading period is established'));
});

test('docx: insertions, deletions and several edits in one paragraph', () => {
  const doc = load('tests/clean/Landing Page V8.7.docx');
  const b = doc.blocks.find((x) => x.text.startsWith('What about my kidneys?'));
  const del = editFor(doc, ' A common concern.', '', 'D1');
  const ins = { id: 'I1', blockId: b.id, start: b.text.length, end: b.text.length, before: '', after: ' Ask your doctor.' };
  const rep = editFor(doc, 'current evidence does not indicate', 'current evidence does not show', 'R1');
  const out = written(doc, [del, ins, rep], 'docx', DATE);
  const t = parseDocx(out.bytes).blockById[b.id].text;
  assert.ok(t.startsWith('What about my kidneys? At recommended doses, current evidence does not show kidney damage'));
  assert.ok(t.endsWith('consult a healthcare professional before use. Ask your doctor.'));
});

test('docx: every seeded quote can be removed with a logged tracked change', () => {
  const dirs = fs.readdirSync(path.join(ROOT, 'tests/seeded')).filter((d) => fs.existsSync(path.join(ROOT, 'tests/seeded', d, 'expected.json')));
  let n = 0;
  for (const d of dirs) {
    const exp = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/seeded', d, 'expected.json'), 'utf8'));
    const doc = load(exp.document);
    const edits = [];
    for (const f of exp.expected_findings) {
      if (!f.quote) continue;
      doc.blocks.filter((b) => b.text.includes(f.quote)).forEach((b, k) => {
        const start = b.text.indexOf(f.quote);
        edits.push({ id: `${f.id}.${k}`, blockId: b.id, start, end: start + f.quote.length, before: f.quote, after: '' });
      });
    }
    if (!edits.length) continue;
    const out = written(doc, edits, null, DATE);
    const again = parseDocx(out.bytes);
    for (const f of exp.expected_findings) if (f.quote) assert.ok(!again.canonicalText.includes(f.quote), `${d}: ${f.quote}`);
    n++;
  }
  assert.ok(n >= 28);
  // Spot-check that LibreOffice opens two of them.
  if (libreOffice()) {
    for (const d of ['omega3-12-repeated-hedged-claim', 'creatine-14-hidden-subscription-terms']) {
      const doc = load(`tests/seeded/${d}/document.docx`);
      const exp = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/seeded', d, 'expected.json'), 'utf8'));
      const e = editFor(doc, exp.expected_findings[0].quote, 'X');
      written(doc, [e], 'docx', DATE);
    }
  }
});

test('docx: unsafe edits are refused, not guessed', () => {
  const doc = load('tests/clean/Landing Page V8.7.docx');
  const e = editFor(doc, 'A common concern.', 'Fine.');
  assert.throws(() => writeDocument(doc, [{ ...e, before: 'wrong text' }]), EditRefused);
  assert.throws(() => writeDocument(doc, [e, { ...e, id: 'E2' }]), /overlaps/);
  assert.throws(() => writeDocument(doc, [{ ...e, after: 'two\nlines' }]), /line breaks/);
  assert.throws(() => writeDocument(doc, [{ ...e, blockId: 'B9999' }]), /unknown block/);
  // An edit covering a line break inside a paragraph.
  const email = load('tests/clean/3 Email Sequence FINAL.docx');
  const b = email.blocks.find((x) => x.pieces.some((p) => p.kind === 'br') && x.text.indexOf('\n') > 0);
  if (b) {
    const i = b.text.indexOf('\n');
    assert.throws(() => writeDocument(email, [{ id: 'E1', blockId: b.id, start: i - 1, end: i + 1, before: b.text.slice(i - 1, i + 1), after: 'x' }]), /tab or line break/);
  }
});

test('docx: header and footer edits change only that part', () => {
  const doc = load('tests/format/omega3_landing.docx');
  const e = editFor(doc, 'landing page copy', 'landing page draft');
  const out = written(doc, [e], 'docx', DATE);
  assert.equal(out.parts['word/document.xml'], doc.parts['word/document.xml']);
  assert.notEqual(out.parts['word/header1.xml'], doc.parts['word/header1.xml']);
});

// ---------------------------------------------------------------- html

test('html: text and attribute edits; tags, entities and other text untouched', () => {
  const doc = load('tests/format/omega3_landing.html');
  const t = editFor(doc, 'Opaque, light-blocking bottle', 'Opaque bottle', 'T1');
  const a = editFor(doc, 'with the lot number on the label', 'with the lot number & "date"', 'A1');
  const out = written(doc, [t, a], 'html');
  assert.ok(out.text.includes('alt="Bottle of PeakFuel Omega-3 softgels with the lot number &amp; &quot;date&quot;"'));
  const before = doc.parts.html;
  const changed = out.rawChanges.reduce((n, c) => n + (c.end - c.start), 0);
  assert.ok(changed < 80);
  assert.equal(out.text.length - before.length, out.rawChanges.reduce((n, c) => n + c.text.length - (c.end - c.start), 0));
});

test('html: an edit across inline markup is refused (becomes a decision later)', () => {
  const doc = load('tests/format/omega3_landing.html');
  const h1 = doc.blocks.find((b) => b.kind === 'h1');
  const e = { id: 'E1', blockId: h1.id, start: 0, end: 16, before: 'PeakFuel Omega-3', after: 'PeakFuel Omega' };
  assert.throws(() => writeDocument(doc, [e]), /crosses formatting or markup/);
});

test('html: replacement text is escaped', () => {
  const doc = parseDocument(intake({ name: 'x.html', bytes: Buffer.from('<p>Price &amp; value.</p><p>Second</p>') }));
  const e = editFor(doc, 'value', '<b>value</b>');
  const out = written(doc, [e]);
  assert.equal(out.text, '<p>Price &amp; &lt;b&gt;value&lt;/b&gt;.</p><p>Second</p>');
});

// ---------------------------------------------------------------- md

test('md: markdown syntax stays intact; replacement is escaped', () => {
  const doc = load('tests/format/omega3_landing.md');
  const cell = editFor(doc, 'No added flavoring, no added color', 'No flavoring | no color *at all*');
  const out = written(doc, [cell]);
  assert.ok(out.text.includes('| Flavoring and color | No flavoring \\| no color \\*at all\\* |'));
  const md = '# Title\n\nSome **bold claim** here and [a link](https://x.y).\n\n> quoted line one\n> quoted line two\n';
  const d2 = parseDocument(intake({ name: 'x.md', bytes: Buffer.from(md) }));
  assert.throws(() => writeDocument(d2, [editFor(d2, 'Some bold', 'Some big')]), /crosses formatting/);
  const ok = written(d2, [editFor(d2, 'bold claim', 'plain claim')]);
  assert.equal(ok.text, md.replace('bold claim', 'plain claim'));
  const lead = written(d2, [editFor(d2, 'Some ', '- ')]);
  assert.ok(lead.text.includes('\n\\- **bold claim**'));
});

// ---------------------------------------------------------------- xlsx

test('xlsx: inline cell edit is highlighted; formulas and numbers untouched', () => {
  const doc = load('tests/format/omega3_landing.xlsx');
  const e = editFor(doc, 'Opaque, light-blocking bottle', 'Opaque bottle');
  const out = written(doc, [e], 'xlsx');
  const again = parseXlsx(out.bytes);
  const cell = again.blocks.find((b) => b.id === e.blockId);
  assert.ok(cell.text.includes('Opaque bottle, nitrogen-flushed'));
  assert.ok(/s="\d+"/.test(again.parts[cell.sheetPath].slice(cell.cellTag.start, cell.cellTag.end)));
  assert.match(out.extraParts['xl/styles.xml'], /FFFFFF00/);
  assert.match(out.extraParts['xl/workbook.xml'], /fullCalcOnLoad="1"/);
  assert.deepEqual(again.otherCells.map((c) => c.raw), doc.otherCells.map((c) => c.raw));
});

function sharedStringWorkbook() {
  const ns = 'http://schemas.openxmlformats.org/';
  return zipSync({
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="${ns}package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${ns}package/2006/relationships"><Relationship Id="rId1" Type="${ns}officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${ns}spreadsheetml/2006/main" xmlns:r="${ns}officeDocument/2006/relationships"><sheets><sheet name="Ads" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${ns}package/2006/relationships"><Relationship Id="rId1" Type="${ns}officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${ns}officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId3" Type="${ns}officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    'xl/styles.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="${ns}spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"/></cellXfs></styleSheet>`),
    'xl/sharedStrings.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><sst xmlns="${ns}spreadsheetml/2006/main" count="4" uniqueCount="3"><si><t>Headline</t></si><si><t>Supports joint comfort &amp; mobility.</t></si><si><r><rPr><b/></rPr><t>Bold start</t></r><r><t xml:space="preserve"> then plain.</t></r></si></sst>`),
    'xl/worksheets/sheet1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${ns}spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s" s="1"><v>1</v></c><c r="B2"><v>19.99</v></c></row><row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3"><f>B2*2</f><v>39.98</v></c></row><row r="4"><c r="A4" t="s"><v>2</v></c></row></sheetData></worksheet>`),
  });
}

test('xlsx: a shared string used by two cells is copied, so only the edited cell changes', () => {
  const doc = parseDocument(intake({ name: 'ads.xlsx', bytes: sharedStringWorkbook() }));
  const a2 = doc.blocks.find((b) => b.ref === 'A2');
  const e = { id: 'E1', blockId: a2.id, start: 9, end: 22, before: 'joint comfort', after: 'everyday movement' };
  const out = written(doc, [e], 'xlsx');
  const again = parseXlsx(out.bytes);
  assert.equal(again.blocks.find((b) => b.ref === 'A2').text, 'Supports everyday movement & mobility.');
  assert.equal(again.blocks.find((b) => b.ref === 'A3').text, 'Supports joint comfort & mobility.');
  assert.match(again.parts['xl/sharedStrings.xml'], /uniqueCount="4"/);
  // Rich text: an edit inside one run works, across runs is refused.
  const a4 = doc.blocks.find((b) => b.ref === 'A4');
  written(doc, [{ id: 'E2', blockId: a4.id, start: 0, end: 4, before: 'Bold', after: 'Strong' }], 'xlsx');
  assert.throws(() => writeDocument(doc, [{ id: 'E3', blockId: a4.id, start: 5, end: 15, before: 'start then', after: 'x' }]), /rich-text|crosses/);
});

// ---------------------------------------------------------------- text

test('text: edits splice the pasted text exactly', () => {
  const src = 'Line one is here.\r\n\r\nSecond paragraph says cures arthritis.\n';
  const doc = parseDocument(intake({ text: src }));
  const out = written(doc, [editFor(doc, 'cures arthritis', 'supports joints')]);
  assert.equal(out.text, src.replace('cures arthritis', 'supports joints'));
});

test('summary of writer checks (for the 10.2 table)', () => {
  console.log(`writer outputs: ${stats.outputs}; text changed without a log entry: ${stats.unloggedChanges}; outputs that failed to reopen: ${stats.reopenFailures}`);
  assert.equal(stats.unloggedChanges, 0);
  assert.equal(stats.reopenFailures, 0);
});
