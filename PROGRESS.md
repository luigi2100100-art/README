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

- **Step 4: Rulebook and precedent formats** (2026-11-27). See `rulebook/README.md`.
  - Formats (JSON schemas) for rules, precedents, patterns and sources, validated on every load.
  - 37 seed rules (FDA 11, FTC 18, Meta 3, TikTok 3, Google 2), 30 precedents from the owner's 20 FDA warning letters, 11 "reads as violating" patterns, 35 registered sources.
  - Every precedent quote is checked word for word against the official letter text; the FDA disclaimer is checked against 21 CFR 101.93(c).
  - Retrieval by channel, category and keywords; staleness warning after 90 days; citation-exists check for the Stage 3 gate.
  - Environment: a new personal environment, "README (compliance sources)", allows the official FDA, FTC, eCFR, govinfo, Meta, TikTok and Google sites (approved by the owner).
  - Dependency added (approved): ajv.

## Next
- **Step 5: Detection passes** (Stage 3, passes 1, 2 and 5) as a command-line tool, using Claude. Needs an Anthropic API key, then measuring on the test set.

## Owner decisions (2026-11-27)
- Risk appetite: **standard** for both products.
- Web app stays at **step 11** (no early test page).
- Step 5 starts only when the owner asks for the secure API-key form.

## Waiting on the owner
- The owner will ask for the secure form to enter the Anthropic API key; then step 5 starts.
- The official link for TikTok's "Weight Management and Body Image" policy (owner will send it).

## Last test results (2026-11-27)
- `npm run check`: test-set integrity passed, rulebook integrity passed; **39 of 39 tests passed**.
- All 46 test-set files pass the Stage 1 gate. The writers produced 43 edited files, all checked; every seeded quote in all 30 seeded documents was removed as a tracked change.
- Section 10.2, the parts measurable without AI:

| Metric | Target | Result |
|---|---|---|
| Text changed without a log entry | 0 | **0** (43 outputs) |
| Output file fails to reopen | 0 | **0** (43 outputs, LibreOffice) |
| Detection, false flags, fixes, citations, injection, decisions per 1,000 words | see spec | not measurable until step 5 |
