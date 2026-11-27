# Progress

Build order: SPEC_v2.md section 13.

## Done
- **Step 1: Repo, CLAUDE.md, folders** (2026-11-27).
- **Step 2: Test set** (2026-11-27). See `tests/README.md`.
  - Clean set: the owner's 12 files, classified in `tests/clean/manifest.json`: 8 documents (2 landing pages, 3 blogs, 1 email sequence, Instagram and TikTok series) and 4 sources (2 research briefs, 2 FAQs).
  - Product facts: `tests/products/omega3.json`, `tests/products/creatine.json`.
  - Seeded set: 30 cases (15 categories × 2 landing pages), 32 expected findings, each with an `expected.json`.
  - Format set: Omega-3 landing page as .docx with header/footer, .md, messy .html, .xlsx.
  - Builder and checker: `tests/tools/build_test_set.py` (Python standard library only, no new dependencies).

## Next
- **Step 3: Parsers and writers** for .docx, .html, .md, .xlsx and text, with the Stage 1 reassembly gate and the round-trip check. No AI. Needs dependency approval first (see below).

## Waiting on the owner
- Approval of dependencies for step 3 onward: a .docx/.xlsx/.html reader-writer, a JSON schema validator, the Anthropic SDK (step 5), Netlify + Netlify Blobs (step 11).
- Confirm `risk_appetite` for each product (assumed "standard").
- Decision: keep the web app at step 11, or build a bare test page earlier.
- Warning letters, policy PDFs and spreadsheets for step 4.

## Last test results (2026-11-27)
- `python3 tests/tools/build_test_set.py --check`: **all checks passed**. 12 clean files hashed; 30 seeded documents contain exactly the planned edits; all 32 expected quotes are present; 33 generated files open in LibreOffice.
- Section 10.2 table: not measurable yet. There's no detector until step 5.
