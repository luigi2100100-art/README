// Rulebook loader, validator, staleness check and retrieval (SPEC_v2 section 6).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RB = path.join(ROOT, 'rulebook');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

let cachedAjv;
function validators() {
  if (cachedAjv) return cachedAjv;
  const ajv = new Ajv({ allErrors: true, strict: true });
  for (const f of ['common.json', 'rule.schema.json', 'precedent.schema.json', 'pattern.schema.json', 'source.schema.json']) {
    ajv.addSchema(readJson(path.join(RB, 'schema', f)));
  }
  cachedAjv = {
    rule: ajv.getSchema('rule.schema.json'),
    precedent: ajv.getSchema('precedent.schema.json'),
    pattern: ajv.getSchema('pattern.schema.json'),
    source: ajv.getSchema('source.schema.json'),
  };
  return cachedAjv;
}

/** Load and validate the whole rulebook. Throws if any record is invalid. */
export function loadRulebook(dir = RB) {
  const manifest = readJson(path.join(dir, 'manifest.json'));
  const rules = [];
  for (const f of fs.readdirSync(path.join(dir, 'rules')).filter((x) => x.endsWith('.json')).sort()) rules.push(...readJson(path.join(dir, 'rules', f)));
  const precedents = [];
  for (const f of fs.readdirSync(path.join(dir, 'precedents')).filter((x) => x.endsWith('.json')).sort()) precedents.push(...readJson(path.join(dir, 'precedents', f)));
  const patterns = readJson(path.join(dir, 'patterns', 'patterns.json'));
  const sources = readJson(path.join(dir, 'sources.json')).sources;
  const rb = { version: manifest.version, manifest, rules, precedents, patterns, sources };
  const problems = validateRulebook(rb);
  if (problems.length) throw new Error('The rulebook has invalid records: ' + problems.slice(0, 5).join('; '));
  rb.ruleById = Object.fromEntries(rules.map((r) => [r.id, r]));
  rb.precedentById = Object.fromEntries(precedents.map((p) => [p.id, p]));
  rb.sourceById = Object.fromEntries(sources.map((s) => [s.id, s]));
  return rb;
}

/** Schema checks plus cross-references. Returns a list of problems. */
export function validateRulebook(rb) {
  const v = validators();
  const problems = [];
  const check = (fn, rec, kind) => {
    if (!fn(rec)) problems.push(`${kind} ${rec.id || '?'}: ${fn.errors.map((e) => `${e.instancePath || '/'} ${e.message}`).join(', ')}`);
  };
  rb.sources.forEach((s) => check(v.source, s, 'source'));
  rb.rules.forEach((r) => check(v.rule, r, 'rule'));
  rb.precedents.forEach((p) => check(v.precedent, p, 'precedent'));
  rb.patterns.forEach((p) => check(v.pattern, p, 'pattern'));
  const unique = (list, kind) => {
    const seen = new Set();
    for (const x of list) { if (seen.has(x.id)) problems.push(`duplicate ${kind} id ${x.id}`); seen.add(x.id); }
    return seen;
  };
  const ruleIds = unique(rb.rules, 'rule');
  const precIds = unique(rb.precedents, 'precedent');
  unique(rb.patterns, 'pattern');
  const srcById = Object.fromEntries(rb.sources.map((s) => [s.id, s]));
  for (const r of rb.rules) {
    const s = srcById[r.source_ref];
    if (!s) problems.push(`rule ${r.id}: unknown source ${r.source_ref}`);
    else if (s.url !== r.source_url || s.date !== r.source_date) problems.push(`rule ${r.id}: source link or date differs from sources.json`);
  }
  for (const p of rb.precedents) {
    for (const id of p.related_rules) if (!ruleIds.has(id)) problems.push(`precedent ${p.id}: unknown rule ${id}`);
    const s = srcById[p.source_ref];
    if (!s) { problems.push(`precedent ${p.id}: unknown source`); continue; }
    if (s.local_text) {
      const norm = (t) => t.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ');
      const text = norm(fs.readFileSync(path.join(ROOT, s.local_text), 'utf8'));
      if (!text.includes(norm(p.quoted_phrase))) problems.push(`precedent ${p.id}: quote not found in the source letter`);
    }
  }
  for (const pat of rb.patterns) {
    for (const id of pat.related_rules) if (!ruleIds.has(id)) problems.push(`pattern ${pat.id}: unknown rule ${id}`);
    for (const id of pat.related_precedents || []) if (!precIds.has(id)) problems.push(`pattern ${pat.id}: unknown precedent ${id}`);
  }
  if (rb.manifest) {
    const m = rb.manifest;
    if (m.counts.rules !== rb.rules.length || m.counts.precedents !== rb.precedents.length || m.counts.patterns !== rb.patterns.length) {
      problems.push('manifest counts do not match the records; rebuild the rulebook');
    }
  }
  return problems;
}

/** Scopes whose rules were last reviewed more than `days` ago (report footer, SPEC 6.1). */
export function staleScopes(rb, today = new Date(), days = rb.manifest?.staleness_days ?? 90) {
  const limit = new Date(today.getTime() - days * 86400000);
  const stale = new Set();
  for (const r of rb.rules) if (new Date(r.last_reviewed + 'T00:00:00Z') < limit) stale.add(r.scope);
  return [...stale].sort().map((scope) => ({ scope, message: `The ${scope} rules were last reviewed more than ${days} days ago and may be out of date.` }));
}

const PLATFORM_SCOPE = { ad_meta: 'Meta', ad_tiktok: 'TikTok', ad_google: 'Google' };

/**
 * Retrieval (SPEC 6.4): channel filter, optional category filter, then keyword
 * scoring against the text. Required-statement rules are always included.
 * Returns full rule records (never only ids), best first.
 */
export function retrieveRules(rb, { channel, categories = [], text = '', limit = 25 } = {}) {
  const lower = text.toLowerCase();
  const scored = [];
  for (const r of rb.rules) {
    if (channel && !r.applies_to.includes(channel)) continue;
    let score = 0;
    if (categories.includes(r.category)) score += 5;
    for (const k of r.keywords || []) if (k && lower.includes(k.toLowerCase())) score += 1;
    if (r.required_text) score += 100; // required statements are always checked
    if (PLATFORM_SCOPE[channel] === r.scope) score += 3;
    if (!categories.length && !text) score += 1;
    if (score > 0 || !text) scored.push({ rule: r, score });
  }
  scored.sort((a, b) => b.score - a.score || a.rule.id.localeCompare(b.rule.id));
  return scored.slice(0, limit).map((x) => x.rule);
}

/** Precedents for a set of rules or a category; only stored records (SPEC 6.2). */
export function precedentsFor(rb, { ruleIds = [], category } = {}) {
  return rb.precedents.filter((p) => p.relevance === 'copy' &&
    (p.related_rules.some((id) => ruleIds.includes(id)) || (category && p.violation_category === category)));
}

/** Gate helper for Stage 3: a citation id must exist in the rulebook. */
export function citationExists(rb, id) {
  return Boolean(rb.ruleById[id] || rb.precedentById[id] || rb.patterns.some((p) => p.id === id));
}

/** Required statements (e.g. the FDA disclaimer), word for word. */
export function requiredStatements(rb) {
  return rb.rules.filter((r) => r.required_text).flatMap((r) => r.required_text.map((text) => ({ ruleId: r.id, text })));
}
