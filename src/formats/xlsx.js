// .xlsx reader and writer. Every text cell is a block located by its address
// ('Sheet'!C14). Formula, number, boolean and error cells are never edited.
// Changed cells are highlighted with a yellow fill.
import { tokenize, pairTokens, attrs, escapeXmlText } from '../xml.js';
import { decodeWithMap } from '../align.js';
import { finalize, validateEdits, applyRawChanges, singlePieceChanges, EditRefused } from '../document.js';
import { readZip, text as zipText, writeZip } from '../zip.js';

const COPY_HEADER = /\b(copy|text|headline|heading|title|subject|preview|body|caption|description|cta|call to action|primary|hook|script|message|post|tagline|claim)\b/i;

function resolveTarget(target) {
  if (target.startsWith('/')) return target.slice(1);
  return 'xl/' + target.replace(/^\.\//, '');
}

function colOf(ref) { return /^[A-Z]+/.exec(ref)[0]; }
function rowOf(ref) { return +/\d+$/.exec(ref)[0]; }

/** Pieces for an <si> or <is> element: plain <t> or rich-text runs <r><t>. Phonetic <rPh> is skipped. */
function stringPieces(xml, toks, pair, from, to) {
  const pieces = [];
  let text = '';
  let skip = 0;
  for (let i = from + 1; i < to; i++) {
    const t = toks[i];
    if (t.name === 'rPh') { if (t.type === 'open') skip++; else if (t.type === 'close') skip--; continue; }
    if (skip || t.type !== 'open' || t.name !== 't') continue;
    const close = pair[i];
    const next = toks[i + 1];
    if (next && next.type === 'text' && i + 2 === close) {
      const d = decodeWithMap(xml, next.start, next.end, 'xml');
      pieces.push({ kind: 'text', start: text.length, end: text.length + d.text.length, rawStart: next.start, rawEnd: next.end, map: d.map, decode: 'xml', editable: true });
      text += d.text;
    }
    i = close;
  }
  return { text, pieces };
}

/** copyColumns: the client's answer, e.g. { 'Ads': ['C', 'D'] }, overrides the guess. */
export function parseXlsx(bytes, { copyColumns = {} } = {}) {
  const entries = readZip(bytes);
  const wb = zipText(entries, 'xl/workbook.xml');
  if (!wb) throw new Error('This is not an Excel workbook (xl/workbook.xml is missing).');
  const doc = { format: 'xlsx', entries, parts: {}, blocks: [], nonCopy: [], warnings: [], otherCells: [], columns: {} };
  const rels = zipText(entries, 'xl/_rels/workbook.xml.rels') || '';
  const relTarget = {};
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0])?.[1];
    const target = /Target="([^"]+)"/.exec(m[0])?.[1];
    if (id && target) relTarget[id] = resolveTarget(target);
  }
  const sheets = [...wb.matchAll(/<sheet\b[^>]*\/?>/g)].map((m) => {
    const tok = { start: 0, end: m[0].length };
    const a = attrs(m[0], tok);
    return { name: a.name.value, path: relTarget[a['r:id'].value], state: a.state?.value };
  });

  // Shared strings.
  const sstName = 'xl/sharedStrings.xml';
  const sst = zipText(entries, sstName);
  const shared = [];
  if (sst) {
    doc.parts[sstName] = sst;
    const toks = tokenize(sst);
    const pair = pairTokens(toks);
    toks.forEach((t, i) => {
      if (t.type === 'open' && t.name === 'si') {
        const sp = stringPieces(sst, toks, pair, i, pair[i]);
        shared.push({ ...sp, siStart: t.start, siEnd: toks[pair[i]].end, refs: 0 });
      } else if (t.type === 'selfclose' && t.name === 'si') {
        shared.push({ text: '', pieces: [], siStart: t.start, siEnd: t.end, refs: 0 });
      }
    });
  }
  doc.shared = shared;

  for (const sh of sheets) {
    if (!sh.path || !entries[sh.path]) continue;
    const xml = zipText(entries, sh.path);
    doc.parts[sh.path] = xml;
    if (sh.state === 'hidden' || sh.state === 'veryHidden') doc.warnings.push(`Sheet '${sh.name}' is hidden; its cells are listed but marked as not copy.`);
    const toks = tokenize(xml);
    const pair = pairTokens(toks);
    const headers = {};
    toks.forEach((t, i) => {
      if (t.name !== 'c' || (t.type !== 'open' && t.type !== 'selfclose')) return;
      const a = attrs(xml, t);
      const ref = a.r?.value;
      if (!ref) return;
      const type = a.t?.value || 'n';
      const end = t.type === 'open' ? pair[i] : i;
      let hasF = false, v = null, isStart = -1;
      for (let k = i + 1; k < end; k++) {
        const c = toks[k];
        if (c.name === 'f' && (c.type === 'open' || c.type === 'selfclose')) hasF = true;
        if (c.name === 'v' && c.type === 'open') v = xml.slice(c.end, toks[pair[k]].start);
        if (c.name === 'is' && c.type === 'open') isStart = k;
      }
      const address = `'${sh.name}'!${ref}`;
      const cellTag = { start: t.start, end: t.end, selfclose: t.type === 'selfclose', s: a.s };
      let block = null;
      if (!hasF && type === 's' && v !== null && shared[+v]) {
        const si = shared[+v];
        si.refs++;
        block = { part: sstName, text: si.text, pieces: si.pieces.map((p) => ({ ...p })), shared: +v };
      } else if (!hasF && type === 'inlineStr' && isStart !== -1) {
        const sp = stringPieces(xml, toks, pair, isStart, pair[isStart]);
        block = { part: sh.path, text: sp.text, pieces: sp.pieces };
      }
      if (block) {
        Object.assign(block, { kind: 'cell', location: address, sheet: sh.name, sheetPath: sh.path, ref, cellTag, hiddenSheet: !!sh.state && sh.state !== 'visible' });
        if (rowOf(ref) === 1) headers[colOf(ref)] = block.text;
        doc.blocks.push(block);
      } else if (t.type === 'open' || v !== null) {
        doc.otherCells.push({ address, sheetPath: sh.path, kind: hasF ? 'formula' : type === 'b' ? 'boolean' : type === 'e' ? 'error' : type === 'str' ? 'formula' : 'number', raw: xml.slice(t.start, toks[end].end) });
      }
    });
    // Copy-column suggestion: a column whose header names copy, or (no
    // header match) the column with the longest text. Ambiguous if unsure.
    const cols = {};
    for (const b of doc.blocks.filter((x) => x.sheet === sh.name && rowOf(x.ref) > 1)) {
      const c = colOf(b.ref);
      (cols[c] ||= { count: 0, chars: 0 });
      cols[c].count++;
      cols[c].chars += b.text.length;
    }
    const named = Object.keys(cols).filter((c) => COPY_HEADER.test(headers[c] || '') && !/\b(note|comment|internal|id|status|owner|date)\b/i.test(headers[c] || ''));
    let suggested = named;
    let ambiguous = false;
    if (!named.length && Object.keys(cols).length) {
      // No header says "copy": guess the column with the longest text, and ask.
      // Short labels (under 25 characters on average) are not treated as copy until confirmed.
      const ranked = Object.entries(cols).sort((x, y) => y[1].chars / y[1].count - x[1].chars / x[1].count);
      suggested = ranked[0][1].chars / ranked[0][1].count >= 25 ? [ranked[0][0]] : [];
      ambiguous = true;
    }
    if (copyColumns[sh.name]) { suggested = copyColumns[sh.name]; ambiguous = false; }
    doc.columns[sh.name] = { headers, suggested, ambiguous };
    for (const b of doc.blocks.filter((x) => x.sheet === sh.name)) {
      b.section = headers[colOf(b.ref)] || '';
      b.isCopy = !b.hiddenSheet && rowOf(b.ref) > 1 && suggested.includes(colOf(b.ref));
    }
  }
  const ambiguous = Object.entries(doc.columns).filter(([, c]) => c.ambiguous).map(([n]) => n);
  if (ambiguous.length) doc.warnings.push(`Please confirm which columns hold copy on: ${ambiguous.join(', ')}.`);
  if (Object.keys(entries).some((n) => /^xl\/(drawings|media)\//.test(n))) doc.warnings.push('The workbook contains drawings or images. Text inside them is not checked.');
  return finalize(doc);
}

const FILL_XML = '<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill>';

/** Add a yellow fill and highlighted copies of the given cell styles. Returns {stylesXml, map: oldStyle->newStyle}. */
function addHighlightStyles(stylesXml, styleIds) {
  let s = stylesXml;
  const fillsM = /<fills\b[^>]*count="(\d+)"[^>]*>([\s\S]*?)<\/fills>/.exec(s);
  if (!fillsM) throw new Error('styles.xml has no fills');
  const fillId = +fillsM[1];
  s = s.replace(fillsM[0], fillsM[0].replace(/count="\d+"/, `count="${fillId + 1}"`).replace('</fills>', FILL_XML + '</fills>'));
  const xfsM = /<cellXfs\b[^>]*count="(\d+)"[^>]*>([\s\S]*?)<\/cellXfs>/.exec(s);
  if (!xfsM) throw new Error('styles.xml has no cellXfs');
  const xfs = [...xfsM[2].matchAll(/<xf\b[^>]*\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g)].map((m) => m[0]);
  let count = +xfsM[1];
  const map = {};
  let added = '';
  for (const id of styleIds) {
    const base = xfs[id] || '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>';
    let xf = /fillId="\d+"/.test(base) ? base.replace(/fillId="\d+"/, `fillId="${fillId}"`) : base.replace('<xf', `<xf fillId="${fillId}"`);
    xf = /applyFill="\d"/.test(xf) ? xf.replace(/applyFill="\d"/, 'applyFill="1"') : xf.replace('<xf', '<xf applyFill="1"');
    map[id] = count++;
    added += xf;
  }
  s = s.replace(xfsM[0], xfsM[0].replace(/count="\d+"/, `count="${count}"`).replace('</cellXfs>', added + '</cellXfs>'));
  return { stylesXml: s, map };
}

export function writeXlsx(doc, edits, { highlight = true } = {}) {
  const byBlock = validateEdits(doc, edits);
  const rawChanges = [];
  const extraParts = {};
  let sst = doc.parts['xl/sharedStrings.xml'];
  let appended = 0;
  const newSi = [];
  const cellStyleChanges = [];
  for (const [blockId, list] of Object.entries(byBlock)) {
    const b = doc.blockById[blockId];
    if (b.shared !== undefined && doc.shared[b.shared].refs > 1) {
      // Shared by other cells: copy the string, edit the copy, point this cell at it.
      const si = doc.shared[b.shared];
      const siRaw = sst.slice(si.siStart, si.siEnd);
      const local = list.map((e) => {
        const host = b.pieces.find((p) => p.editable && p.start <= e.start && e.end <= p.end);
        if (!host) throw new EditRefused(e.id, 'the change crosses rich-text formatting');
        const a = host.map[e.start - host.start], z = host.map[e.end - host.start];
        return { start: a - si.siStart, end: z - si.siStart, text: escapeXmlText(e.after) };
      }).sort((x, y) => y.start - x.start);
      let copy = siRaw;
      for (const c of local) copy = copy.slice(0, c.start) + c.text + copy.slice(c.end);
      const idx = doc.shared.length + appended++;
      newSi.push(copy);
      const cellXml = doc.parts[b.sheetPath];
      const cellEnd = cellXml.indexOf('</c>', b.cellTag.end);
      const vM = /<v>(\d+)<\/v>/.exec(cellXml.slice(b.cellTag.end, cellEnd));
      const vStart = b.cellTag.end + vM.index + 3;
      rawChanges.push({ part: b.sheetPath, start: vStart, end: vStart + vM[1].length, text: String(idx), editIds: list.map((e) => e.id) });
    } else {
      for (const c of singlePieceChanges(doc, list, (t) => escapeXmlText(t))) rawChanges.push({ ...c, editIds: [c.editId] });
    }
    cellStyleChanges.push(b);
  }
  if (newSi.length) {
    const m = /<sst\b[^>]*>/.exec(sst);
    let head = m[0];
    const bump = (attr, by) => { head = head.replace(new RegExp(`${attr}="(\\d+)"`), (_, n) => `${attr}="${+n + by}"`); };
    const totalNew = newSi.length;
    bump('uniqueCount', totalNew);
    rawChanges.push({ part: 'xl/sharedStrings.xml', start: m.index, end: m.index + m[0].length, text: head, editIds: [] });
    const endIdx = sst.lastIndexOf('</sst>');
    rawChanges.push({ part: 'xl/sharedStrings.xml', start: endIdx, end: endIdx, text: newSi.join(''), editIds: [] });
  }
  if (highlight && cellStyleChanges.length) {
    const stylesName = 'xl/styles.xml';
    const stylesXml = zipText(doc.entries, stylesName);
    const ids = [...new Set(cellStyleChanges.map((b) => +(b.cellTag.s?.value || 0)))];
    const { stylesXml: newStyles, map } = addHighlightStyles(stylesXml, ids);
    extraParts[stylesName] = newStyles;
    for (const b of cellStyleChanges) {
      const old = +(b.cellTag.s?.value || 0);
      if (b.cellTag.s) rawChanges.push({ part: b.sheetPath, start: b.cellTag.s.start, end: b.cellTag.s.end, text: String(map[old]), editIds: [] });
      else {
        const pos = b.cellTag.start + 2; // after "<c"
        rawChanges.push({ part: b.sheetPath, start: pos, end: pos, text: ` s="${map[old]}"`, editIds: [] });
      }
    }
  }
  const parts = applyRawChanges(doc.parts, rawChanges);
  // Formula results may now be stale: ask Excel to recalculate on open.
  if (doc.otherCells.some((c) => c.kind === 'formula') && edits.length) {
    const wb = zipText(doc.entries, 'xl/workbook.xml');
    extraParts['xl/workbook.xml'] = /<calcPr\b/.test(wb)
      ? wb.replace(/<calcPr\b([^>]*?)(\/?)>/, (all, a, sl) => (/fullCalcOnLoad/.test(a) ? all : `<calcPr${a} fullCalcOnLoad="1"${sl}>`))
      : wb.replace('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>');
  }
  const changed = Object.fromEntries(Object.entries(parts).filter(([k, v]) => v !== doc.parts[k]));
  return { bytes: writeZip(doc.entries, { ...changed, ...extraParts }), rawChanges, parts, extraParts };
}

export const xlsxDecode = 'xml';
