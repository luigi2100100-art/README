// .docx reader and writer. Edits are written as tracked changes (w:del/w:ins),
// splicing only the runs they touch; every other byte stays as it was.
import { tokenize, pairTokens, attrs, escapeXmlText, escapeXmlAttr } from '../xml.js';
import { decodeWithMap } from '../align.js';
import { finalize, validateEdits, applyRawChanges, EditRefused } from '../document.js';
import { readZip, text as zipText, writeZip } from '../zip.js';

const DEFAULT_AUTHOR = 'Compliance Review Tool';

function textParts(entries) {
  const names = Object.keys(entries);
  const pick = (re) => names.filter((n) => re.test(n)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  return [
    ...pick(/^word\/document\.xml$/),
    ...pick(/^word\/header\d*\.xml$/),
    ...pick(/^word\/footer\d*\.xml$/),
    ...pick(/^word\/footnotes\.xml$/),
    ...pick(/^word\/endnotes\.xml$/),
  ];
}

function partLabel(name) {
  if (name === 'word/document.xml') return 'Body';
  const m = /word\/(header|footer)(\d*)\.xml/.exec(name);
  if (m) return `${m[1] === 'header' ? 'Header' : 'Footer'} ${m[2] || 1}`;
  return /footnotes/.test(name) ? 'Footnotes' : 'Endnotes';
}

/**
 * Parse a .docx. view: 'accepted' (default: text as it reads with existing
 * tracked changes accepted) or 'rejected' (as it read before them).
 */
export function parseDocx(bytes, { view = 'accepted' } = {}) {
  const entries = readZip(bytes);
  if (!entries['word/document.xml']) throw new Error('This is not a Word document (word/document.xml is missing).');
  const doc = { format: 'docx', view, entries, parts: {}, blocks: [], nonCopy: [], warnings: [] };
  let images = 0;
  let tracked = 0;

  for (const part of textParts(entries)) {
    const xml = zipText(entries, part);
    doc.parts[part] = xml;
    const toks = tokenize(xml);
    const pair = pairTokens(toks);
    const label = partLabel(part);
    const isBody = part === 'word/document.xml';
    const pStack = [];
    const runStack = [];
    const tblStack = [];
    let ins = 0, del = 0, inPPr = 0, pCount = 0, tblCount = 0, section = isBody ? '' : `(${label.toLowerCase()})`;

    const addPiece = (b, s, piece) => {
      piece.start = b.text.length;
      b.text += s;
      piece.end = b.text.length;
      b.pieces.push(piece);
    };
    const visible = () => (view === 'accepted' ? del === 0 : ins === 0);

    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.type !== 'open' && t.type !== 'selfclose' && t.type !== 'close') continue;
      const name = t.name;
      if (t.type === 'close') {
        if (name === 'w:p') {
          const b = pStack.pop();
          if (/^h\d$/.test(b.kind) && isBody) section = b.text.trim() || section;
          b.section = /^h\d$/.test(b.kind) ? b.text.trim() : section;
          doc.blocks.push(b);
        } else if (name === 'w:r') runStack.pop();
        else if (name === 'w:ins' || name === 'w:moveTo') ins--;
        else if (name === 'w:del' || name === 'w:moveFrom') del--;
        else if (name === 'w:pPr') inPPr--;
        else if (name === 'w:tbl') tblStack.pop();
        continue;
      }
      const cur = pStack[pStack.length - 1];
      switch (name) {
        case 'w:p': {
          if (t.type === 'selfclose') { pCount++; break; }
          pCount++;
          const tb = tblStack[tblStack.length - 1];
          pStack.push({
            part, kind: tb ? 'cell' : 'p', text: '', pieces: [], area: isBody ? 'body' : label.toLowerCase(),
            location: tb ? `${label} table ${tb.n} row ${tb.row} cell ${tb.col}` : `${label} paragraph ${pCount}`,
          });
          break;
        }
        case 'w:pPr': if (t.type === 'open') inPPr++; break;
        case 'w:pStyle': {
          if (cur && inPPr) {
            const v = attrs(xml, t)['w:val']?.value || '';
            const m = /^Heading\s?(\d)$/i.exec(v);
            if (m) cur.kind = 'h' + m[1];
            else if (/^Title$/i.test(v)) cur.kind = 'h1';
            else if (/^Subtitle$/i.test(v)) cur.kind = 'h2';
          }
          break;
        }
        case 'w:numPr': if (cur && inPPr && cur.kind === 'p') cur.kind = 'li'; break;
        case 'w:tbl': if (t.type === 'open') tblStack.push({ n: ++tblCount, row: 0, col: 0 }); break;
        case 'w:tr': if (tblStack.length) { tblStack[tblStack.length - 1].row++; tblStack[tblStack.length - 1].col = 0; } break;
        case 'w:tc': if (tblStack.length) tblStack[tblStack.length - 1].col++; break;
        case 'w:r': if (t.type === 'open') runStack.push({ start: t.start, end: toks[pair[i]].end }); break;
        case 'w:ins': case 'w:moveTo': if (t.type === 'open') { ins++; tracked++; } break;
        case 'w:del': case 'w:moveFrom': if (t.type === 'open') { del++; tracked++; } break;
        case 'w:drawing': case 'w:pict': case 'w:object': if (t.type === 'open') images++; break;
        case 'w:t': case 'w:delText': {
          if (!cur || !runStack.length || t.type === 'selfclose') break;
          const isDelText = name === 'w:delText';
          const include = isDelText ? view === 'rejected' : visible();
          const next = toks[i + 1];
          const close = toks[pair[i]];
          if (!include || !next || next.type !== 'text' || toks[i + 2] !== close) break;
          const d = decodeWithMap(xml, next.start, next.end, 'xml');
          const run = runStack[runStack.length - 1];
          addPiece(cur, d.text, {
            kind: 'text', rawStart: next.start, rawEnd: next.end, map: d.map, decode: 'xml',
            editable: !isDelText && ins === 0 && del === 0 && view === 'accepted',
            run, tStart: t.start, tEnd: close.end,
          });
          break;
        }
        case 'w:tab': case 'w:br': case 'w:cr': case 'w:noBreakHyphen': {
          if (!cur || !runStack.length || inPPr || !visible()) break;
          const s = name === 'w:tab' ? '\t' : name === 'w:noBreakHyphen' ? '‑' : '\n';
          addPiece(cur, s, { kind: name.slice(2), rawStart: t.start, rawEnd: t.end, map: null, editable: false, run: runStack[runStack.length - 1] });
          break;
        }
        default: break;
      }
    }
  }
  const comments = zipText(entries, 'word/comments.xml');
  if (comments) {
    for (const m of comments.matchAll(/<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g)) {
      const author = /w:author="([^"]*)"/.exec(m[1])?.[1] || '';
      const body = [...m[2].matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((x) => x[1]).join('');
      if (body) doc.nonCopy.push({ kind: 'comment', author, text: body });
    }
  }
  if (images) doc.warnings.push(`${images} image(s) found. Text inside images is not checked.`);
  if (tracked) doc.warnings.push('The document already contains tracked changes. The text is read with them accepted, and no edits will be made inside them.');
  return finalize(doc);
}

/** Split runs for tracked edits. Returns raw changes. */
function runRewrites(doc, byBlock, { author, date }) {
  const changes = [];
  const nextId = {};
  const idFor = (part) => {
    if (nextId[part] === undefined) {
      let max = 0;
      for (const m of doc.parts[part].matchAll(/w:id="(\d+)"/g)) max = Math.max(max, +m[1]);
      nextId[part] = max + 1;
    }
    return nextId[part]++;
  };
  const changeAttrs = (part) => `w:id="${idFor(part)}" w:author="${escapeXmlAttr(author)}" w:date="${date}"`;

  for (const [blockId, edits] of Object.entries(byBlock)) {
    const b = doc.blockById[blockId];
    const xml = doc.parts[b.part];
    const hosts = new Map(); // edit id -> piece
    for (const e of edits) {
      const covered = b.pieces.filter((p) => p.start < e.end && p.end > e.start);
      for (const p of covered) {
        if (p.kind !== 'text') throw new EditRefused(e.id, 'the change covers a tab or line break');
        if (!p.editable) throw new EditRefused(e.id, 'the change touches an existing tracked change');
      }
      let host;
      if (e.end > e.start) host = covered.find((p) => p.start < e.end && e.end <= p.end);
      else host = b.pieces.find((p) => p.kind === 'text' && p.editable && p.start < e.start && e.start <= p.end) ||
        b.pieces.find((p) => p.kind === 'text' && p.editable && p.start <= e.start && e.start < p.end);
      if (!host) throw new EditRefused(e.id, 'no editable text at that position');
      hosts.set(e.id, host);
    }
    const runs = new Map();
    for (const e of edits) {
      for (const p of b.pieces) {
        if ((p.start < e.end && p.end > e.start) || hosts.get(e.id) === p) runs.set(p.run.start, p.run);
      }
    }
    for (const run of runs.values()) {
      const raw = xml.slice(run.start, run.end);
      const rt = tokenize(raw);
      const rp = pairTokens(rt);
      const openTag = raw.slice(rt[0].start, rt[0].end);
      let rPr = '';
      const atoms = [];
      for (let i = 1; i < rt.length - 1; i++) {
        const t = rt[i];
        if (t.type !== 'open' && t.type !== 'selfclose') {
          if (t.type === 'text' && raw.slice(t.start, t.end).trim() === '') atoms.push({ type: 'raw', raw: raw.slice(t.start, t.end) });
          continue;
        }
        const endIdx = t.type === 'open' ? rp[i] : i;
        const childRaw = raw.slice(t.start, rt[endIdx].end);
        i = endIdx;
        if (t.name === 'w:rPr') { rPr = childRaw; continue; }
        const piece = t.name === 'w:t' ? b.pieces.find((p) => p.kind === 'text' && p.tStart === run.start + t.start) : null;
        if (!piece) { atoms.push({ type: 'raw', raw: childRaw }); continue; }
        // Cut points inside this piece.
        const cuts = new Set([piece.start, piece.end]);
        const insHere = [];
        for (const e of edits) {
          if (e.start > piece.start && e.start < piece.end) cuts.add(e.start);
          if (e.end > piece.start && e.end < piece.end) cuts.add(e.end);
          if (hosts.get(e.id) === piece && e.after) insHere.push({ at: e.end, text: e.after, id: e.id });
        }
        const pts = [...cuts].sort((x, y) => x - y);
        const emitted = new Set();
        const rawOf = (a, z) => xml.slice(piece.map[a - piece.start], piece.map[z - piece.start]);
        for (let k = 0; k < pts.length - 1; k++) {
          const a = pts[k], z = pts[k + 1];
          for (const ins of insHere) if (!emitted.has(ins.id) && ins.at <= a) { atoms.push({ type: 'ins', text: ins.text }); emitted.add(ins.id); }
          const isDel = edits.some((e) => e.start < e.end && e.start <= a && z <= e.end);
          if (piece.map[a - piece.start] === -1 || piece.map[z - piece.start] === -1) {
            throw new EditRefused(edits[0].id, 'the change starts or ends inside an encoded character');
          }
          atoms.push({ type: isDel ? 'del' : 'text', raw: rawOf(a, z) });
        }
        for (const ins of insHere) if (!emitted.has(ins.id)) { atoms.push({ type: 'ins', text: ins.text }); emitted.add(ins.id); }
      }
      // Group atoms into runs.
      let out = '';
      let i = 0;
      while (i < atoms.length) {
        const type = atoms[i].type === 'raw' ? 'text' : atoms[i].type;
        let j = i;
        const group = [];
        while (j < atoms.length && (atoms[j].type === 'raw' ? 'text' : atoms[j].type) === type) group.push(atoms[j++]);
        if (type === 'text') {
          const body = group.map((a) => (a.type === 'raw' ? a.raw : `<w:t xml:space="preserve">${a.raw}</w:t>`)).join('');
          if (body.trim()) out += `${openTag}${rPr}${body}</w:r>`;
        } else if (type === 'del') {
          out += `<w:del ${changeAttrs(b.part)}>${openTag}${rPr}<w:delText xml:space="preserve">${group.map((a) => a.raw).join('')}</w:delText></w:r></w:del>`;
        } else {
          for (const a of group) {
            out += `<w:ins ${changeAttrs(b.part)}>${openTag}${rPr}<w:t xml:space="preserve">${escapeXmlText(a.text)}</w:t></w:r></w:ins>`;
          }
        }
        i = j;
      }
      changes.push({ part: b.part, start: run.start, end: run.end, text: out, editIds: edits.map((e) => e.id) });
    }
  }
  return changes;
}

/**
 * Apply edits as tracked changes. edits: [{id, blockId, start, end, before, after}]
 * Returns { bytes, rawChanges, parts }.
 */
export function writeDocx(doc, edits, { author = DEFAULT_AUTHOR, date = new Date().toISOString().replace(/\.\d+Z$/, 'Z') } = {}) {
  if (doc.view !== 'accepted') throw new Error('write from the accepted view');
  const byBlock = validateEdits(doc, edits);
  const rawChanges = runRewrites(doc, byBlock, { author, date });
  const parts = applyRawChanges(doc.parts, rawChanges);
  const changed = Object.fromEntries(Object.entries(parts).filter(([k, v]) => v !== doc.parts[k]));
  return { bytes: writeZip(doc.entries, changed), rawChanges, parts };
}

export const docxDecode = 'xml';
