// Rulebook formats and seed records (SPEC_v2 section 6, build step 4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, load } from './helpers.js';
import { loadRulebook, validateRulebook, staleScopes, retrieveRules, precedentsFor, citationExists, requiredStatements } from '../src/rulebook.js';

const rb = loadRulebook();

test('every record passes its schema and cross-reference checks', () => {
  assert.deepEqual(validateRulebook(rb), []);
  assert.match(rb.version, /^\d{4}\.\d{2}\.\d{2}-[0-9a-f]{8}$/);
});

test('seed sizes meet step 4: at least 30 rules and 20 precedents', () => {
  assert.ok(rb.rules.length >= 30, `${rb.rules.length} rules`);
  assert.ok(rb.precedents.length >= 20, `${rb.precedents.length} precedents`);
  for (const scope of ['FDA', 'FTC', 'Meta', 'TikTok', 'Google']) assert.ok(rb.rules.some((r) => r.scope === scope), scope);
  assert.ok(rb.patterns.every((p) => p.examples.length >= 3));
});

test('every rule has a real source link and a retrieval date (no source, no record)', () => {
  for (const r of rb.rules) {
    const s = rb.sourceById[r.source_ref];
    assert.ok(s, r.id);
    assert.match(r.source_url, /^https:\/\//);
    assert.match(s.retrieved, /^\d{4}-\d{2}-\d{2}$/);
  }
  // Links that could not be opened from the tool are labelled, not hidden.
  for (const s of rb.sources.filter((x) => !x.url_verified)) assert.ok(s.notes && s.notes.length > 20, s.id);
});

test('a tampered precedent quote is caught', () => {
  const bad = structuredClone({ ...rb, ruleById: undefined, precedentById: undefined, sourceById: undefined });
  bad.precedents[0].quoted_phrase = 'This product cures everything, says FDA.';
  assert.ok(validateRulebook(bad).some((p) => /quote not found/.test(p)));
  const bad2 = structuredClone({ ...rb, ruleById: undefined, precedentById: undefined, sourceById: undefined });
  bad2.rules[0].source_url = 'http://example.com';
  assert.ok(validateRulebook(bad2).length > 0);
  const bad3 = structuredClone({ ...rb, ruleById: undefined, precedentById: undefined, sourceById: undefined });
  bad3.precedents[0].related_rules = ['FDA-XXX-99'];
  assert.ok(validateRulebook(bad3).some((p) => /unknown rule/.test(p)));
});

test('the required FDA statement is word for word the one in the test set and the CFR', () => {
  const texts = requiredStatements(rb).map((s) => s.text);
  const plural = 'These statements have not been evaluated by the Food and Drug Administration. This product is not intended to diagnose, treat, cure, or prevent any disease.';
  assert.ok(texts.includes(plural));
  const builder = fs.readFileSync(path.join(ROOT, 'tests/tools/build_test_set.py'), 'utf8');
  assert.ok(builder.replace(/"\s*\n\s*"/g, '').includes(plural));
  const cfr = fs.readFileSync(path.join(ROOT, 'rulebook/sources/regulations/21-CFR-101.93.txt'), 'utf8');
  for (const t of texts) assert.ok(cfr.includes(t), t);
});

test('staleness: nothing is stale today, everything is after 91 days', () => {
  assert.deepEqual(staleScopes(rb, new Date('2026-11-28T00:00:00Z')), []);
  const later = staleScopes(rb, new Date('2027-03-01T00:00:00Z'));
  assert.deepEqual(later.map((s) => s.scope), ['FDA', 'FTC', 'Google', 'Meta', 'TikTok']);
  assert.match(later[0].message, /may be out of date/);
});

test('retrieval: channel filter, keyword ranking, required statements always included', () => {
  const doc = load('tests/seeded/omega3-01-disease-claim/document.docx');
  const lp = retrieveRules(rb, { channel: 'landing_page', text: doc.canonicalText });
  assert.ok(lp.every((r) => r.applies_to.includes('landing_page')));
  assert.ok(!lp.some((r) => r.scope === 'Meta'));
  assert.equal(lp[0].id, 'FDA-DISC-01');
  assert.ok(lp.some((r) => r.id === 'FDA-DIS-01'));
  assert.ok(lp.every((r) => r.rule_summary && r.source_url), 'full records, not only ids');
  const meta = retrieveRules(rb, { channel: 'ad_meta', text: 'Say goodbye to diabetes. Perfect for teens.' });
  assert.ok(meta.some((r) => r.id === 'META-HW-02') && meta.some((r) => r.id === 'META-HW-01'));
  const byCat = retrieveRules(rb, { channel: 'email', categories: ['hidden_subscription_terms'], text: 'x', limit: 3 });
  assert.ok(byCat.some((r) => r.id === 'FTC-NEG-01'));
});

test('precedents: only stored records, linked to rules; citation ids are checkable', () => {
  const ps = precedentsFor(rb, { ruleIds: ['FDA-DIS-05'] });
  assert.ok(ps.length >= 2 && ps.every((p) => p.relevance === 'copy' && p.source_url.startsWith('https://www.fda.gov/')));
  assert.ok(citationExists(rb, 'FDA-DIS-01') && citationExists(rb, 'P-001') && citationExists(rb, 'PAT-01'));
  assert.ok(!citationExists(rb, 'FDA-DIS-99') && !citationExists(rb, 'P-999'));
});
