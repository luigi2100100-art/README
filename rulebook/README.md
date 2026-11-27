# Rulebook (SPEC_v2 section 6)

Version and counts: see `manifest.json`. Rebuild after any edit, then check:

    python3 rulebook/tools/build_rulebook.py
    python3 rulebook/tools/build_rulebook.py --check   # also part of `npm run check`

## What's here

| Path | Contents |
|---|---|
| `rules/*.json` | 37 rules: FDA 11, FTC 18, Meta 3, TikTok 3, Google 2. Each has a plain-words summary, citation, source link and date, examples, fix patterns, severity, channels and `auto_fixable`. |
| `precedents/fda-warning-letters-2025.json` | 30 precedents from the owner's 20 FDA warning letters (2025): a short quoted phrase, category and reasoning summary, with a link. |
| `patterns/patterns.json` | 11 "reads as violating overall" patterns, each with 3 illustrative examples and the usual fix. |
| `sources.json` | Every cited document: publisher, link, date, retrieval date, where it came from, and whether the link was opened and matched from this tool (`url_verified`). |
| `sources/` | Public-domain texts kept for checking: the 20 FDA letters, 21 CFR 101.93, 21 U.S.C. 343(r)(6), 16 CFR 255/465/323 and 15 U.S.C. 8403. Copyrighted platform policies are not stored. |
| `schema/` | JSON schemas for every record type. |
| `tools/` | The editable data (`rules_data.py`, `precedents_data.py`, `patterns_data.py`) and the builder. |

## Checks that run every time

- Every record matches its schema; ids are unique; every cross-reference (rule, precedent, source) exists.
- **Every precedent quote appears word for word in the official FDA letter text.** A changed or invented quote fails the build.
- The required FDA statement matches 21 CFR 101.93(c) word for word, and matches the test set.
- Each rule's link and date match `sources.json`.
- Staleness: a rule reviewed more than 90 days ago puts a footer warning on reports for its scope.

## Where things came from

- **Owner's Google Drive folder:** the 20 FDA warning letters (links confirmed on fda.gov), the FTC Health Products Compliance Guidance, the FTC Endorsement Guides FAQ, Meta Health and Wellness, the two TikTok policies, and Google Healthcare and medicines.
- **Public sources fetched from here:** eCFR (21 CFR 101.93; 16 CFR 255, 465, 323), govinfo (21 U.S.C. 343(r)(6), 15 U.S.C. 8403), FDA guidance pages, and Google's Unapproved substances page.
- **Not checked from here:** ftc.gov refuses automated requests, so the two FTC document links are marked `url_verified: false`. The TikTok Weight Management link is also unconfirmed (please add the article link).
- **The FDA Health Fraud sheet (41 entries)** is not imported. It has no link or quoted wording per entry, so the tool couldn't cite it (spec 6.1: "No source, no record").

## Adding a record

Add it to the right file in `tools/`, add its source to `sources.json` first, rebuild, and run `npm run check`.
