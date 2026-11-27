#!/usr/bin/env python3
"""Build and check the test set (SPEC_v2 section 10.1, build step 2).

Uses only the Python standard library. LibreOffice, if installed, is used in
--check mode to confirm that every generated file opens.

    python3 tests/tools/build_test_set.py          # build seeded + format sets
    python3 tests/tools/build_test_set.py --check  # verify everything, no writes
"""
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from xml.sax.saxutils import escape

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FDA = ("These statements have not been evaluated by the Food and Drug Administration. "
       "This product is not intended to diagnose, treat, cure, or prevent any disease.")
FIXED_TIME = (2026, 1, 1, 0, 0, 0)

P_RE = re.compile(r"<w:p[ >].*?</w:p>", re.S)
T_RE = re.compile(r"(<w:t(?: [^>]*)?>)(.*?)(</w:t>)", re.S)
RUN_RE = re.compile(r"<w:r[ >].*?</w:r>", re.S)
RPR_RE = re.compile(r"<w:rPr>.*?</w:rPr>|<w:rPr/>", re.S)
PPR_RE = re.compile(r"<w:pPr>.*?</w:pPr>|<w:pPr/>", re.S)


def p(*parts):
    return os.path.join(ROOT, *parts)


def sha256(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def dump_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


class BuildError(Exception):
    pass


# ---------------------------------------------------------------- docx text

def para_text(pxml):
    return "".join(html.unescape(m.group(2)) for m in T_RE.finditer(pxml))


def read_docx(path):
    with zipfile.ZipFile(path) as z:
        return z.read("word/document.xml").decode("utf-8")


def docx_paragraphs(path):
    return [para_text(m.group(0)) for m in P_RE.finditer(read_docx(path))]


def write_zip(src_path, dst_path, replace):
    """Copy a zip, replacing/adding members, with fixed timestamps."""
    os.makedirs(os.path.dirname(dst_path), exist_ok=True)
    with zipfile.ZipFile(src_path) as zin, zipfile.ZipFile(dst_path, "w", zipfile.ZIP_DEFLATED) as zout:
        names = zin.namelist()
        for name in names:
            data = replace.get(name)
            if data is None:
                data = zin.read(name)
            zout.writestr(zipfile.ZipInfo(name, FIXED_TIME), data, zipfile.ZIP_DEFLATED)
        for name, data in replace.items():
            if name not in names:
                zout.writestr(zipfile.ZipInfo(name, FIXED_TIME), data, zipfile.ZIP_DEFLATED)


# ---------------------------------------------------------------- edits

def select(texts, edit, key):
    find = edit[key]
    exact = edit.get("exact", False)
    hits = [i for i, t in enumerate(texts) if (t == find if exact else find in t)]
    nth = edit.get("nth")
    if nth is not None:
        if len(hits) < nth:
            raise BuildError(f"'{find}' has only {len(hits)} matches, nth={nth}")
        return hits[nth - 1]
    if len(hits) != 1:
        raise BuildError(f"'{find}' must match exactly one paragraph, found {len(hits)}")
    return hits[0]


def apply_text(texts, edit):
    """Plain-text model of an edit. Used to check the docx result."""
    t = list(texts)
    op = edit["op"]
    if op == "insert_after":
        t.insert(select(t, edit, "anchor") + 1, edit["text"])
    elif op == "replace":
        i = select(t, edit, "find")
        t[i] = t[i].replace(edit["find"], edit["with"], 1)
    elif op == "replace_paragraph":
        t[select(t, edit, "find")] = edit["text"]
    elif op == "append":
        t[select(t, edit, "find")] += edit["text"]
    elif op == "delete_paragraph":
        del t[select(t, edit, "find")]
    else:
        raise BuildError(f"unknown op {op}")
    return t


def new_paragraph(template, text):
    ppr = PPR_RE.search(template)
    ppr = ppr.group(0) if ppr else ""
    body = template[ppr and template.find(ppr) + len(ppr) or 0:]
    run = RUN_RE.search(body)
    rpr = RPR_RE.search(run.group(0)).group(0) if run and RPR_RE.search(run.group(0)) else ""
    return f'<w:p>{ppr}<w:r>{rpr}<w:t xml:space="preserve">{escape(text)}</w:t></w:r></w:p>'


def new_run_like_last(pxml, text):
    runs = RUN_RE.findall(pxml)
    rpr = ""
    if runs:
        m = RPR_RE.search(runs[-1])
        rpr = m.group(0) if m else ""
    return f'<w:r>{rpr}<w:t xml:space="preserve">{escape(text)}</w:t></w:r>'


def replace_in_paragraph(pxml, find, new):
    """Replace inside one <w:t> when possible (keeps formatting)."""
    for m in T_RE.finditer(pxml):
        txt = html.unescape(m.group(2))
        if find in txt:
            repl = f'<w:t xml:space="preserve">{escape(txt.replace(find, new, 1))}</w:t>'
            return pxml[:m.start()] + repl + pxml[m.end():]
    full = para_text(pxml).replace(find, new, 1)
    return new_paragraph(pxml, full)


def apply_docx(xml, edit):
    spans = [(m.start(), m.end(), m.group(0)) for m in P_RE.finditer(xml)]
    texts = [para_text(s[2]) for s in spans]
    op = edit["op"]
    key = "anchor" if op == "insert_after" else "find"
    i = select(texts, edit, key)
    start, end, pxml = spans[i]
    if op == "insert_after":
        tmpl = pxml
        if edit.get("style_from"):
            tmpl = spans[select(texts, {"find": edit["style_from"]}, "find")][2]
        out = pxml + new_paragraph(tmpl, edit["text"])
    elif op == "replace":
        out = replace_in_paragraph(pxml, edit["find"], edit["with"])
    elif op == "replace_paragraph":
        out = new_paragraph(pxml, edit["text"])
    elif op == "append":
        k = pxml.rfind("</w:p>")
        out = pxml[:k] + new_run_like_last(pxml, edit["text"]) + pxml[k:]
    elif op == "delete_paragraph":
        out = ""
    else:
        raise BuildError(f"unknown op {op}")
    return xml[:start] + out + xml[end:]


# ---------------------------------------------------------------- seeded set

def build_seeded(write=True):
    spec = load_json(p("tests", "seeded", "cases.json"))
    problems, summary = [], []
    ids = set()
    for case in spec["cases"]:
        cid = case["id"]
        try:
            if cid in ids:
                raise BuildError("duplicate case id")
            ids.add(cid)
            base = spec["bases"][case["base"]]
            base_path = p(base["file"])
            xml = read_docx(base_path)
            base_texts = [para_text(m.group(0)) for m in P_RE.finditer(xml)]
            want = base_texts
            for e in case["edits"]:
                want = apply_text(want, e)
                xml = apply_docx(xml, e)
            out_dir = p("tests", "seeded", cid)
            out_doc = os.path.join(out_dir, "document.docx")
            tmp = out_doc if write else os.path.join(tempfile.mkdtemp(), "document.docx")
            write_zip(base_path, tmp, {"word/document.xml": xml.encode("utf-8")})
            got = docx_paragraphs(tmp)
            # Gate: the docx must contain exactly the intended text and nothing else.
            if got != want:
                raise BuildError("docx text differs from the intended edits")
            full = "\n".join(got)
            base_full = "\n".join(base_texts)
            for f in case["expected"]:
                q = f.get("quote")
                if q is None:
                    if f["category"] == "missing_disclaimer" and FDA in full:
                        raise BuildError("FDA statement still present")
                    continue
                n = full.count(q)
                if n == 0:
                    raise BuildError(f"quote not in document: {q}")
                if f.get("occurrences") and n != f["occurrences"]:
                    raise BuildError(f"quote appears {n} times, expected {f['occurrences']}: {q}")
                if q in base_full and f["category"] not in ("context_mismatch_dose", "context_mismatch_age"):
                    raise BuildError(f"quote already in the clean base: {q}")
                rq = f.get("related_quote")
                if rq and rq not in full:
                    raise BuildError(f"related quote not in document: {rq}")
            expected = {
                "case_id": cid,
                "base_file": base["file"],
                "base_sha256": sha256(base_path),
                "document": f"tests/seeded/{cid}/document.docx",
                "document_sha256": sha256(tmp),
                "product": base["product"],
                "product_facts": f"tests/products/{base['product']}.json",
                "channel": base["channel"],
                "sources": "none (Rules-only mode)",
                "edits": case["edits"],
                "expected_findings": [dict(id=f"E{k+1}", **f) for k, f in enumerate(case["expected"])],
                "report_must_not_contain": case.get("report_must_not_contain", ["compliant", "approved", "safe to publish"]),
                "min_issues": case.get("min_issues", len(case["expected"])),
                "fda_statement_count": full.count(FDA),
                "unchanged_text_rule": "Every paragraph not touched by 'edits' is identical to the clean base, so the clean-set expectations still apply to it.",
            }
            if write:
                dump_json(os.path.join(out_dir, "expected.json"), expected)
            else:
                on_disk = os.path.join(out_dir, "expected.json")
                if not os.path.exists(on_disk) or load_json(on_disk) != expected:
                    raise BuildError("expected.json is missing or out of date; rebuild")
                if sha256(os.path.join(out_dir, "document.docx")) != expected["document_sha256"]:
                    raise BuildError("document.docx is out of date; rebuild")
            summary.append((cid, [f["category"] for f in case["expected"]], [f["severity"] for f in case["expected"]]))
        except (BuildError, KeyError) as ex:
            problems.append(f"{cid}: {ex}")
    return summary, problems


# ---------------------------------------------------------------- clean set

def build_clean(write=True):
    man = load_json(p("tests", "clean", "manifest.json"))
    problems, docs = [], []
    listed = {f["file"] for f in man["files"]}
    on_disk = {f for f in os.listdir(p("tests", "clean")) if f.endswith(".docx")}
    for f in sorted(on_disk - listed):
        problems.append(f"clean: {f} is not in manifest.json")
    for f in sorted(listed - on_disk):
        problems.append(f"clean: manifest lists missing file {f}")
    for entry in man["files"]:
        path = p("tests", "clean", entry["file"])
        if not os.path.exists(path):
            continue
        texts = docx_paragraphs(path)
        full = "\n".join(texts)
        rec = {"file": entry["file"], "sha256": sha256(path), "product": entry["product"],
               "role": entry["role"], "words": len(full.split())}
        if entry["role"] == "document":
            rec.update({
                "channel": entry["channel"],
                "fda_statement_count": full.count(FDA),
                "max_high_severity_findings": 0,
                "max_false_flags": 2,
                "max_protected_span_edits": 0,
                "fda_statement_must_be_untouched": True,
            })
        docs.append(rec)
    expected = {"about": "Clean-set expectations (SPEC_v2 10.1). Documents should produce no high-severity findings, at most 2 false flags, no edits to protected spans, and the FDA statement untouched. Sources are Tier 2 material, not checked as copy.",
                "products": {"omega3": "tests/products/omega3.json", "creatine": "tests/products/creatine.json"},
                "files": docs}
    out = p("tests", "clean", "expected.json")
    if write:
        dump_json(out, expected)
    elif not os.path.exists(out) or load_json(out) != expected:
        problems.append("clean: expected.json is missing or out of date (a clean file changed?); rebuild")
    return docs, problems


# ---------------------------------------------------------------- format set

def docx_blocks(path):
    """Top-level blocks: (kind, text) or ('table', rows)."""
    xml = read_docx(path)
    body = xml[xml.find("<w:body>") + 8: xml.rfind("</w:body>")]
    blocks = []
    for part in re.split(r"(<w:tbl>.*?</w:tbl>)", body, flags=re.S):
        if part.startswith("<w:tbl>"):
            rows = []
            for tr in re.findall(r"<w:tr[ >].*?</w:tr>", part, re.S):
                rows.append([" ".join(t for t in (para_text(x) for x in P_RE.findall(tc)) if t)
                             for tc in re.findall(r"<w:tc>.*?</w:tc>", tr, re.S)])
            blocks.append(("table", rows))
            continue
        for pxml in P_RE.findall(part):
            text = para_text(pxml)
            if not text.strip():
                continue
            style = re.search(r'<w:pStyle w:val="([^"]+)"', pxml)
            style = style.group(1) if style else ""
            if style.startswith("Heading"):
                kind = "h" + style[-1]
            elif "<w:numPr>" in pxml:
                kind = "li"
            else:
                kind = "p"
            blocks.append((kind, text))
    return blocks


def to_markdown(blocks):
    out, prev = [], None
    for kind, val in blocks:
        if kind == "table":
            out.append("")
            out.append("| " + " | ".join(val[0]) + " |")
            out.append("|" + "---|" * len(val[0]))
            for r in val[1:]:
                out.append("| " + " | ".join(c.replace("|", "\\|") for c in r) + " |")
            out.append("")
        elif kind.startswith("h"):
            out += ["", "#" * int(kind[1]) + " " + val, ""]
        elif kind == "li":
            if prev != "li":
                out.append("")
            out.append("- " + val)
        else:
            out += ["", val, ""]
        prev = kind
    text = "\n".join(out)
    return re.sub(r"\n{3,}", "\n\n", text).strip() + "\n"


def to_messy_html(blocks, meta_desc, alt):
    """Deliberately messy markup, as exported by page builders."""
    e = lambda s: escape(s).replace("  ", " &nbsp;")
    out = ['<!DOCTYPE html>', '<HTML lang="en"><HEAD>', '<meta charset="utf-8">',
           f'<meta name="description" content="{escape(meta_desc, {chr(34): "&quot;"})}">',
           '<title>PeakFuel Omega-3 | Fish Oil Concentrate</title>',
           '<style>.hero{font-weight:700} /* cures everything */</style>',
           '<script>var promo = "This script text cures arthritis and must never be read as copy";'
           ' dataLayer.push({event:"view"});</script>',
           '</HEAD><BODY>', '<!-- builder export v3; comment text is not copy: guaranteed results -->',
           '<div class="wrap" style="margin:0 auto"><div><div>']
    in_list = False
    first_h1 = True
    for kind, val in blocks:
        if kind != "li" and in_list:
            out.append("</UL>")
            in_list = False
        if kind == "table":
            out.append('<TABLE border="0" cellpadding="4"><tbody>')
            for i, r in enumerate(val):
                tag = "th" if i == 0 else "td"
                out.append("<tr>" + "".join(f'<{tag} style="padding:4px"><span>{e(c)}</span></{tag}>' for c in r) + "</tr>")
            out.append("</tbody></TABLE>")
        elif kind == "h1" and first_h1 and val.startswith("PeakFuel"):
            first_h1 = False
            out.append(f'<h1 class="hero"><span>Peak</span><span style="color:#0a5">Fuel</span>{e(val[8:])}</h1>')
            out.append(f'<img src="/img/bottle.png" alt="{escape(alt, {chr(34): "&quot;"})}" title="PeakFuel Omega-3 bottle, front panel">')
        elif kind.startswith("h"):
            out.append(f"<{kind}><font>{e(val)}</font></{kind}>")
        elif kind == "li":
            if not in_list:
                out.append("<UL>")
                in_list = True
            out.append(f"<li>{e(val)}")  # unclosed <li>, as many exporters write
        else:
            out.append(f'<p style="line-height:1.5"><span class="c1">{e(val)}</span>')  # unclosed <p>
        if val == "Pick one bottle or a subscription at checkout → [ADD LINK]":
            out.append('<button type="button" aria-label="Choose one bottle or a subscription">Choose my bottle</button>')
    if in_list:
        out.append("</UL>")
    out += ["</div></div></div>", '<div style="display:none" id="tracking">utm_source=email</div>', "</BODY></HTML>"]
    return "\n".join(out) + "\n"


def col(n):
    s = ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def xlsx_cell(ref, v):
    if isinstance(v, tuple):  # (formula, cached value)
        f, cached = v
        if isinstance(cached, str):
            return f'<c r="{ref}" t="str"><f>{escape(f)}</f><v>{escape(cached)}</v></c>'
        return f'<c r="{ref}"><f>{escape(f)}</f><v>{cached}</v></c>'
    if isinstance(v, (int, float)):
        return f'<c r="{ref}"><v>{v}</v></c>'
    return f'<c r="{ref}" t="inlineStr"><is><t xml:space="preserve">{escape(v)}</t></is></c>'


def xlsx_sheet(rows):
    out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
           '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>']
    for r, row in enumerate(rows, 1):
        out.append(f'<row r="{r}">' + "".join(xlsx_cell(f"{col(c)}{r}", v) for c, v in enumerate(row, 1) if v is not None) + "</row>")
    out.append("</sheetData></worksheet>")
    return "".join(out)


def write_xlsx(path, sheets):
    ns = "http://schemas.openxmlformats.org/"
    files = {
        "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<Types xmlns="{ns}package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            + "".join(f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' for i in range(1, len(sheets) + 1))
            + "</Types>",
        "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<Relationships xmlns="{ns}package/2006/relationships">'
            f'<Relationship Id="rId1" Type="{ns}officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        "xl/workbook.xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<workbook xmlns="{ns}spreadsheetml/2006/main" xmlns:r="{ns}officeDocument/2006/relationships"><sheets>'
            + "".join(f'<sheet name="{escape(n)}" sheetId="{i}" r:id="rId{i}"/>' for i, (n, _) in enumerate(sheets, 1))
            + "</sheets></workbook>",
        "xl/_rels/workbook.xml.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<Relationships xmlns="{ns}package/2006/relationships">'
            + "".join(f'<Relationship Id="rId{i}" Type="{ns}officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i}.xml"/>' for i in range(1, len(sheets) + 1))
            + f'<Relationship Id="rId{len(sheets) + 1}" Type="{ns}officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
        "xl/styles.xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<styleSheet xmlns="{ns}spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
            '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
            '<borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf/></cellXfs></styleSheet>',
    }
    for i, (_, rows) in enumerate(sheets, 1):
        files[f"xl/worksheets/sheet{i}.xml"] = xlsx_sheet(rows)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files.items():
            z.writestr(zipfile.ZipInfo(name, FIXED_TIME), data.encode("utf-8"), zipfile.ZIP_DEFLATED)


def add_header_footer(src, dst, header, footer):
    with zipfile.ZipFile(src) as z:
        doc = z.read("word/document.xml").decode()
        rels = z.read("word/_rels/document.xml.rels").decode()
        ctypes = z.read("[Content_Types].xml").decode()
    w = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    part = lambda tag, text: (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:{tag} {w}>'
                              f'<w:p><w:r><w:t xml:space="preserve">{escape(text)}</w:t></w:r></w:p></w:{tag}>')
    rel_t = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/"
    rels = rels.replace("</Relationships>",
                        f'<Relationship Id="rIdTsHdr1" Type="{rel_t}header" Target="header1.xml"/>'
                        f'<Relationship Id="rIdTsFtr1" Type="{rel_t}footer" Target="footer1.xml"/></Relationships>')
    ct = "application/vnd.openxmlformats-officedocument.wordprocessingml."
    ctypes = ctypes.replace("</Types>",
                            f'<Override PartName="/word/header1.xml" ContentType="{ct}header+xml"/>'
                            f'<Override PartName="/word/footer1.xml" ContentType="{ct}footer+xml"/></Types>')
    m = re.search(r"<w:sectPr[^>]*>", doc)
    if not m or "headerReference" in doc:
        raise BuildError("unexpected section properties in base docx")
    doc = doc[:m.end()] + ('<w:headerReference w:type="default" r:id="rIdTsHdr1"/>'
                           '<w:footerReference w:type="default" r:id="rIdTsFtr1"/>') + doc[m.end():]
    write_zip(src, dst, {"word/document.xml": doc.encode(), "word/_rels/document.xml.rels": rels.encode(),
                         "[Content_Types].xml": ctypes.encode(),
                         "word/header1.xml": part("hdr", header).encode(), "word/footer1.xml": part("ftr", footer).encode()})


def build_format(write=True):
    problems = []
    base_rel = "tests/clean/Copy of PeakFuel Omega-3 Landing Page V10.docx"
    base = p(base_rel)
    blocks = docx_blocks(base)
    header = "PeakFuel Nutrition | Omega-3 landing page copy | V10"
    footer = "© 2026 PeakFuel Nutrition. All rights reserved."
    meta_desc = "PeakFuel Omega-3: EPA and DHA printed on the front panel, with a certificate of analysis for every lot."
    alt = "Bottle of PeakFuel Omega-3 softgels with the lot number on the label"
    out_dir = p("tests", "format") if write else tempfile.mkdtemp()

    add_header_footer(base, os.path.join(out_dir, "omega3_landing.docx"), header, footer)
    md = to_markdown(blocks)
    hx = to_messy_html(blocks, meta_desc, alt)
    with open(os.path.join(out_dir, "omega3_landing.md"), "w", encoding="utf-8") as f:
        f.write(md)
    with open(os.path.join(out_dir, "omega3_landing.html"), "w", encoding="utf-8") as f:
        f.write(hx)

    # xlsx: a copy deck, one row per block; table rows flattened as "Label: value".
    rows = [["Section", "Element", "Copy", "Characters", "Notes"]]
    section = ""
    for kind, val in blocks:
        items = ([("table header", " | ".join(val[0]))] + [("table row", f"{r[0]}: {r[1]}") for r in val[1:]]) if kind == "table" else [(kind, val)]
        if kind in ("h1", "h2"):
            section = val
        for el, text in items:
            n = len(rows) + 1
            rows.append([section, el, text, (f"LEN(C{n})", len(text)), None])
    rows[1][4] = "Internal: confirm headline with brand team"
    pricing = [["Item", "Price (USD)", "Subscriber price (USD)"],
               ["Single bottle", 32, ("ROUND(B2*0.9,2)", 28.8)],
               ["Shipping, single bottle", 4.95, None],
               ["Free shipping threshold", 50, None]]
    write_xlsx(os.path.join(out_dir, "omega3_landing.xlsx"), [("Landing page", rows), ("Pricing", pricing)])

    copy_texts = []
    for kind, val in blocks:
        if kind == "table":
            copy_texts += [c for r in val for c in r if c]
        else:
            copy_texts.append(val)
    expected = {
        "about": "Format set (SPEC_v2 10.1): the Omega-3 landing page in four formats. Step 3 parsers must pass the reassembly gate on every file and find these copy units. Content is the clean landing page, so the clean-set expectations apply.",
        "content_source": base_rel,
        "content_source_sha256": sha256(base),
        "copy_texts": copy_texts,
        "files": {
            "omega3_landing.docx": {
                "must_include_as_copy": [header, footer],
                "protected": [footer],
                "notes": "Tables and a page header and footer. Header and footer text are copy units; the footer is a legal footer and is protected."},
            "omega3_landing.md": {
                "notes": "Markdown syntax (#, -, |) must be kept intact; only the text inside it is copy."},
            "omega3_landing.html": {
                "must_include_as_copy": [meta_desc, alt, "PeakFuel Omega-3 bottle, front panel", "PeakFuel Omega-3 | Fish Oil Concentrate",
                                         "Choose my bottle", "Choose one bottle or a subscription", "PeakFuel Omega-3"],
                "must_exclude_from_copy": ["This script text cures arthritis and must never be read as copy",
                                           "cures everything", "guaranteed results", "utm_source=email"],
                "notes": "Messy export: uppercase tags, unclosed <p> and <li>, inline styles, &nbsp;, a word split across two <span>s, script, style, comment and a hidden tracking div. The H1 must read as one word 'PeakFuel'."},
            "omega3_landing.xlsx": {
                "copy_cells": "Sheet 'Landing page', column C, rows 2 onward",
                "never_edit": "Every formula cell (column D on 'Landing page', C2 on 'Pricing') and every number cell",
                "not_copy": "Columns A, B and E on 'Landing page' are labels and internal notes; the 'Pricing' sheet holds numbers and item labels",
                "rows": len(rows),
                "notes": "Cell addresses (e.g. 'Landing page'!C2) are the unit locations."},
        },
    }
    if write:
        dump_json(p("tests", "format", "expected.json"), expected)
    else:
        for name in ("omega3_landing.docx", "omega3_landing.md", "omega3_landing.html", "omega3_landing.xlsx"):
            a, b = os.path.join(out_dir, name), p("tests", "format", name)
            if not os.path.exists(b) or sha256(a) != sha256(b):
                problems.append(f"format: {name} is missing or out of date; rebuild")
        on_disk = p("tests", "format", "expected.json")
        if not os.path.exists(on_disk) or load_json(on_disk) != expected:
            problems.append("format: expected.json is missing or out of date; rebuild")
    # Self-checks on content.
    for t in copy_texts:
        if t not in md:
            problems.append(f"format: markdown is missing copy text: {t[:50]}")
    for t in expected["files"]["omega3_landing.html"]["must_exclude_from_copy"]:
        if t not in hx:
            problems.append(f"format: html is missing planted non-copy text: {t}")
    return expected, problems


# ---------------------------------------------------------------- open check

def libreoffice_open_check():
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        return None, ["LibreOffice not installed: open check skipped"]
    files = [os.path.join(dp, f) for dp, _, fs in os.walk(p("tests")) for f in fs
             if f.endswith((".docx", ".xlsx", ".html")) and "/clean/" not in dp + "/"]
    problems = []
    out = tempfile.mkdtemp()
    groups = {"txt:Text": [f for f in files if f.endswith((".docx", ".html"))],
              "csv": [f for f in files if f.endswith(".xlsx")]}
    for fmt, group in groups.items():
        for f in group:  # same basename in many folders: convert one by one
            d = tempfile.mkdtemp(dir=out)
            subprocess.run([soffice, "--headless", "--convert-to", fmt, "--outdir", d, f],
                           capture_output=True, timeout=180)
            if not os.listdir(d) or os.path.getsize(os.path.join(d, os.listdir(d)[0])) == 0:
                problems.append(f"does not open in LibreOffice: {os.path.relpath(f, ROOT)}")
    shutil.rmtree(out, ignore_errors=True)
    return len(files), problems


# ---------------------------------------------------------------- main

def main():
    check = "--check" in sys.argv
    clean, p1 = build_clean(write=not check)
    seeded, p2 = build_seeded(write=not check)
    fmt, p3 = build_format(write=not check)
    opened, p4 = libreoffice_open_check() if check else (None, [])
    problems = p1 + p2 + p3 + p4

    docs = [d for d in clean if d["role"] == "document"]
    print(f"Clean set:   {len(docs)} documents, {len(clean) - len(docs)} source files")
    cats = sorted({c for _, cs, _ in seeded for c in cs})
    n_findings = sum(len(cs) for _, cs, _ in seeded)
    n_high = sum(s.count("high") for _, _, s in seeded)
    print(f"Seeded set:  {len(seeded)} cases, {n_findings} expected findings ({n_high} high), {len(cats)} categories")
    print(f"Format set:  4 files, {len(fmt['copy_texts'])} copy texts")
    if opened is not None:
        print(f"Open check:  {opened} generated files tried in LibreOffice")
    if problems:
        print("\nPROBLEMS:")
        for x in problems:
            print(" -", x)
        sys.exit(1)
    print("\nAll test-set checks passed." if check else "\nBuilt. Run with --check to verify.")


if __name__ == "__main__":
    main()
