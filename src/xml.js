// Minimal, position-preserving XML tokenizer for OOXML parts (.docx, .xlsx).
// It never re-serialises a document: writers splice the original string at
// token offsets, so everything they don't touch stays byte-identical.

/**
 * @typedef {{type:'open'|'close'|'selfclose'|'text'|'comment'|'pi'|'cdata'|'doctype',
 *            name?:string, start:number, end:number}} Token
 */

/** @returns {Token[]} */
export function tokenize(xml) {
  const out = [];
  let i = 0;
  const n = xml.length;
  while (i < n) {
    if (xml[i] !== '<') {
      const j = xml.indexOf('<', i);
      const end = j === -1 ? n : j;
      out.push({ type: 'text', start: i, end });
      i = end;
      continue;
    }
    if (xml.startsWith('<!--', i)) {
      const j = xml.indexOf('-->', i + 4);
      if (j === -1) throw new Error(`unterminated comment at ${i}`);
      out.push({ type: 'comment', start: i, end: j + 3 });
      i = j + 3;
    } else if (xml.startsWith('<![CDATA[', i)) {
      const j = xml.indexOf(']]>', i + 9);
      if (j === -1) throw new Error(`unterminated CDATA at ${i}`);
      out.push({ type: 'cdata', start: i, end: j + 3 });
      i = j + 3;
    } else if (xml.startsWith('<?', i)) {
      const j = xml.indexOf('?>', i + 2);
      if (j === -1) throw new Error(`unterminated processing instruction at ${i}`);
      out.push({ type: 'pi', start: i, end: j + 2 });
      i = j + 2;
    } else if (xml.startsWith('<!', i)) {
      const j = xml.indexOf('>', i + 2);
      if (j === -1) throw new Error(`unterminated declaration at ${i}`);
      out.push({ type: 'doctype', start: i, end: j + 1 });
      i = j + 1;
    } else {
      // A tag. Skip over quoted attribute values, which may contain '>'.
      let j = i + 1;
      let quote = null;
      for (; j < n; j++) {
        const c = xml[j];
        if (quote) { if (c === quote) quote = null; }
        else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
      }
      if (j >= n) throw new Error(`unterminated tag at ${i}`);
      const raw = xml.slice(i, j + 1);
      if (raw[1] === '/') {
        out.push({ type: 'close', name: raw.slice(2, -1).trim(), start: i, end: j + 1 });
      } else {
        const m = /^<([^\s/>]+)/.exec(raw);
        if (!m) throw new Error(`bad tag at ${i}`);
        out.push({ type: raw.endsWith('/>') ? 'selfclose' : 'open', name: m[1], start: i, end: j + 1 });
      }
      i = j + 1;
    }
  }
  return out;
}

/** Attributes of a tag token: name -> {value, start, end} (value offsets are absolute, inside the quotes). */
export function attrs(xml, tok) {
  const res = {};
  const raw = xml.slice(tok.start, tok.end);
  const re = /([^\s=/<>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  const nameEnd = /^<[^\s/>]+/.exec(raw)[0].length;
  re.lastIndex = nameEnd;
  while ((m = re.exec(raw))) {
    const value = m[3] !== undefined ? m[3] : m[4];
    const vStart = tok.start + m.index + m[0].length - 1 - value.length;
    res[m[1]] = { value: decodeXml(value), raw: value, start: vStart, end: vStart + value.length };
  }
  return res;
}

const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decode one XML entity body (without & and ;). Returns null if unknown. */
export function xmlEntity(body) {
  if (body in XML_ENT) return XML_ENT[body];
  if (/^#x[0-9a-fA-F]+$/.test(body)) return String.fromCodePoint(parseInt(body.slice(2), 16));
  if (/^#[0-9]+$/.test(body)) return String.fromCodePoint(parseInt(body.slice(1), 10));
  return null;
}

export function decodeXml(s) {
  return s.replace(/&([^;&\s]{1,10});/g, (all, body) => {
    const v = xmlEntity(body);
    return v === null ? all : v;
  });
}

export function escapeXmlText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeXmlAttr(s) {
  return escapeXmlText(s).replace(/"/g, '&quot;');
}

/**
 * Match each open tag with its close tag. Returns an array `pair` where
 * pair[i] is the index of the matching token for open/close tokens.
 */
export function pairTokens(tokens) {
  const pair = new Array(tokens.length).fill(-1);
  const stack = [];
  tokens.forEach((t, i) => {
    if (t.type === 'open') stack.push(i);
    else if (t.type === 'close') {
      const j = stack.pop();
      if (j === undefined || tokens[j].name !== t.name) {
        throw new Error(`mismatched </${t.name}> at ${t.start}`);
      }
      pair[i] = j;
      pair[j] = i;
    }
  });
  if (stack.length) throw new Error(`unclosed <${tokens[stack[stack.length - 1]].name}>`);
  return pair;
}
