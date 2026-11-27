#!/usr/bin/env python3
"""Build and check the rulebook (SPEC_v2 section 6). Standard library only.

    python3 rulebook/tools/build_rulebook.py          # write rulebook/rules, precedents, patterns, manifest
    python3 rulebook/tools/build_rulebook.py --check  # verify files are up to date, nothing written
"""
import hashlib, json, os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, HERE)
from rules_data import RULES          # noqa: E402
from precedents_data import P         # noqa: E402
from patterns_data import PATTERNS    # noqa: E402

REVIEWED = "2026-11-27"
VERSION_DATE = "2026.11.27"

def path(*p): return os.path.join(ROOT, *p)
def norm(s):
    s = s.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"').replace("–", "-").replace("—", "-")
    return re.sub(r"\s+", " ", s).strip()

def build():
    problems = []
    sources = {s["id"]: s for s in json.load(open(path("rulebook", "sources.json")))["sources"]}
    rules = []
    for r in RULES:
        r = dict(r)
        src = sources.get(r.pop("src"))
        if not src:
            problems.append(f"{r['id']}: unknown source"); continue
        rec = {"id": r["id"], "scope": {"FDA": "FDA", "FTC": "FTC", "META": "Meta", "TT": "TikTok", "GOOG": "Google"}[r["id"].split("-")[0]],
               "title": r["title"], "category": r["category"], "rule_summary": r["rule_summary"],
               "source_ref": src["id"], "source_url": src["url"], "source_title": src["title"], "source_date": src["date"],
               "citation": r["citation"]}
        if "required_text" in r: rec["required_text"] = r["required_text"]
        rec.update({"last_reviewed": REVIEWED, "severity": r["severity"], "violating_examples": r["violating_examples"],
                    "compliant_examples": r["compliant_examples"], "fix_patterns": r["fix_patterns"], "auto_fixable": r["auto_fixable"],
                    "applies_to": r["applies_to"], "tags": r["tags"], "keywords": r.get("keywords", [])})
        if "notes" in r: rec["notes"] = r["notes"]
        if not src["url_verified"]:
            rec["notes"] = (rec.get("notes", "") + " Source link not checked from this tool; see sources.json.").strip()
        # Required text must exist verbatim in the stored regulation text.
        for t in rec.get("required_text", []):
            lt = src.get("local_text")
            if lt and norm(t) not in norm(open(path(lt)).read()):
                problems.append(f"{rec['id']}: required text not found in {lt}")
        rules.append(rec)
    ids = [r["id"] for r in rules]
    if len(ids) != len(set(ids)): problems.append("duplicate rule ids")
    rule_ids = set(ids)

    precedents = []
    for i, (cms, quote, cat, rel, related, reasoning, where) in enumerate(P, 1):
        src = sources.get(f"SRC-FDA-WL-{cms}")
        if not src:
            problems.append(f"P-{i:03d}: no source for letter {cms}"); continue
        text = norm(open(path(src["local_text"])).read())
        if norm(quote) not in text:
            problems.append(f"P-{i:03d}: quote not found word for word in letter {cms}: {quote}")
        for rid in related:
            if rid not in rule_ids: problems.append(f"P-{i:03d}: unknown rule {rid}")
        company = re.sub(r"^Warning Letter: | \(MARCS-CMS \d+\)$", "", src["title"])
        precedents.append({"id": f"P-{i:03d}", "agency": "FDA", "case_date": src["date"], "company": company, "letter_id": cms,
                           "quoted_phrase": quote, "violation_category": cat, "agency_reasoning_summary": reasoning,
                           "source_url": src["url"], "source_ref": src["id"], "related_rules": related, "relevance": rel,
                           "channel_found": where})
    prec_ids = {p["id"] for p in precedents}
    patterns = []
    for p in PATTERNS:
        for rid in p["related_rules"]:
            if rid not in rule_ids: problems.append(f"{p['id']}: unknown rule {rid}")
        for pid in p.get("related_precedents", []):
            if pid not in prec_ids: problems.append(f"{p['id']}: unknown precedent {pid}")
        patterns.append(p)

    by_scope = {}
    for r in rules: by_scope.setdefault(r["scope"].lower(), []).append(r)
    files = {f"rulebook/rules/{k}.json": v for k, v in sorted(by_scope.items())}
    files["rulebook/precedents/fda-warning-letters-2025.json"] = precedents
    files["rulebook/patterns/patterns.json"] = patterns
    blob = json.dumps(files, sort_keys=True, ensure_ascii=False).encode()
    manifest = {"version": f"{VERSION_DATE}-{hashlib.sha256(blob).hexdigest()[:8]}", "last_reviewed": REVIEWED,
                "counts": {"rules": len(rules), "precedents": len(precedents), "patterns": len(patterns), "sources": len(sources)},
                "rules_by_scope": {k: len(v) for k, v in sorted(by_scope.items())},
                "files": sorted(files), "content_sha256": hashlib.sha256(blob).hexdigest(),
                "staleness_days": 90}
    files["rulebook/manifest.json"] = manifest
    return files, problems

def dump(obj): return json.dumps(obj, indent=2, ensure_ascii=False) + "\n"

def main():
    check = "--check" in sys.argv
    files, problems = build()
    if not check and not problems:
        for name, obj in files.items():
            os.makedirs(os.path.dirname(path(name)), exist_ok=True)
            open(path(name), "w").write(dump(obj))
    if check:
        for name, obj in files.items():
            if not os.path.exists(path(name)) or open(path(name)).read() != dump(obj):
                problems.append(f"{name} is missing or out of date; rebuild")
    m = files["rulebook/manifest.json"]
    print(f"Rulebook {m['version']}: {m['counts']['rules']} rules {m['rules_by_scope']}, {m['counts']['precedents']} precedents, {m['counts']['patterns']} patterns, {m['counts']['sources']} sources")
    if problems:
        print("PROBLEMS:"); [print(" -", p) for p in problems]; sys.exit(1)
    print("All rulebook checks passed." if check else "Built.")

if __name__ == "__main__":
    main()
