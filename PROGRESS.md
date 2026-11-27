# Progress

Build order: SPEC_v2.md section 13.

## Done
- **Step 1: Repo, CLAUDE.md, folders** (2026-11-27).
- **Step 2: Test set** (2026-11-27). 12 clean files (8 documents, 4 sources), product facts, 30 seeded cases, format set. See `tests/README.md`.
- **Step 3: Parsers and writers** (2026-11-27). No AI.
  - Stage 0 intake: accepts .docx, .xlsx, .html, .md, .txt and pasted text; clear messages for anything else; 10 MB limit; SHA-256; warnings for images and existing tracked changes.
  - Stage 1: every format is split into blocks and sentence-level units (`U001`…) with location, section heading and offset. The gate checks that the units reassemble every paragraph and the whole text, that every piece maps back to the original bytes, and that writing back with no edits gives identical files. If any check fails, the run stops with a plain message.
  - Writers: .docx edits are tracked changes (rejecting them restores the original). .xlsx edits highlight the changed cells and never touch formulas or numbers. A shared string used by other cells gets copied, so only the edited cell changes. .html and .md edits never touch tags or markdown syntax. Edits that would cross formatting, tabs, line breaks or existing tracked changes are refused (to become "Needs decision" later).
  - Round-trip check (Stage 7.7, and the byte part of 7.1): every changed byte maps to a logged change, unedited parts are byte-identical, and the output reopens with the intended text.
  - Excel: copy columns are guessed from the headers. If unsure, the tool asks (a warning, plus an option to pass the answer).
  - Dependencies added (approved): fflate, parse5, entities, mdast-util-from-markdown, mdast-util-gfm, micromark-extension-gfm.

## Next
- **Step 4: Rulebook and precedent formats**, with 30 seed rules and 20 precedents, each with a source URL and date.

## Waiting on the owner
- Warning letters, policy PDFs and spreadsheets for step 4 (otherwise I collect public sources myself).
- Confirm `risk_appetite` for each product (assumed "standard").
- Decision: keep the web app at step 11, or build a bare test page earlier.

## Last test results (2026-11-27)
- `npm run check`: test-set integrity passed; **31 of 31 tests passed**.
- All 46 test-set files pass the Stage 1 gate. The writers produced 43 edited files, all checked; every seeded quote in all 30 seeded documents was removed as a tracked change.
- Section 10.2, the parts measurable without AI:

| Metric | Target | Result |
|---|---|---|
| Text changed without a log entry | 0 | **0** (43 outputs) |
| Output file fails to reopen | 0 | **0** (43 outputs, LibreOffice) |
| Detection, false flags, fixes, citations, injection, decisions per 1,000 words | see spec | not measurable until step 5 |
