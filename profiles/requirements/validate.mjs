#!/usr/bin/env node
// requirements 검증 — 요구사항·수용기준·미결(기본값)·범위 밖·변경 내역의 결정적 검사. 형식 정본은 FORMAT.md 다.
// usage: node profiles/requirements/validate.mjs <case-dir>
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeResolver } from '../../scripts/lib/locators.mjs';
import { loadConfig } from '../../scripts/lib/pipeline.mjs';

export const DEFAULT_OPEN_BUDGET = 10;
const STANCES = ['follow-existing', 're-review', 'ask-plan', 'ask-design', 'ask-backend'];
const SEVERITY = ['high', 'medium', 'low'];
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const blank = (v) => !String(v ?? '').trim();

export function validate(caseDir, plan = readJson(join(caseDir, 'workplan.json'))) {
  const out = [];
  const err = (w, m) => out.push(`${w}: ${m}`);
  const registry = readJson(join(caseDir, 'sources.json'));
  const extracts = Object.fromEntries(registry.sources.map((s) => [s.id, existsSync(join(caseDir, 'extract', `${s.id}.json`)) ? readJson(join(caseDir, 'extract', `${s.id}.json`)) : { anchors: [] }]));
  const locators = makeResolver(caseDir, registry, extracts);
  const ref = (w, r) => { if (!r?.sourceId || !r?.locator) return err(w, 'sourceId·locator 가 필요함'); const v = locators.resolve(r.sourceId, r.locator); if (!v.ok) err(w, v.reason); };
  if (plan.kind !== 'Requirements') err('kind', 'Requirements 여야 함');
  if ([...plan.inputDigests ?? []].sort().join() !== registry.sources.map((s) => s.sha256).sort().join()) err('inputDigests', '등록된 원본과 다름');
  const ids = new Set();
  const claim = (id, w) => { if (!id || ids.has(id)) err(w, `id 가 없거나 중복 — ${id}`); ids.add(id); };
  const list = (k) => (Array.isArray(plan[k]) ? plan[k] : []);
  const conditions = new Set((plan.conditions ?? []).map((c) => c.id));

  if (!list('requirements').length) err('requirements', '요구사항이 없음');
  list('requirements').forEach((x, i) => {
    const w = `requirements[${i}]`; claim(x.id, w);
    if (!/^R-\d+$/.test(x.id ?? '')) err(w, 'id 는 R-<번호>');
    if (blank(x.statement)) err(w, 'statement 가 없음');
    if (!(x.conditions ?? []).length) err(w, 'conditions(이 요구사항이 나온 조건)가 없음');
    for (const c of x.conditions ?? []) if (!conditions.has(c)) err(w, `없는 조건 — ${c}`);
    (x.sourceRefs ?? []).forEach((r, j) => ref(`${w}.sourceRefs[${j}]`, r));
    // 수용기준은 검증할 수 있어야 한다: 어떤 조건(when)에서 무엇이 관찰되는가(then).
    if (!Array.isArray(x.acceptance) || !x.acceptance.length) err(w, 'acceptance 가 없음');
    (x.acceptance ?? []).forEach((a, j) => { if (typeof a !== 'object' || blank(a.when) || blank(a.then)) err(`${w}.acceptance[${j}]`, 'when(상황·조작)과 then(관찰할 수 있는 결과)이 필요함'); });
  });
  const budget = loadConfig(caseDir).profiles?.requirements?.openBudget ?? DEFAULT_OPEN_BUDGET;
  if (list('open').length > budget) err('open', `미결 ${list('open').length}건이 예산 ${budget}건을 넘음 — 원본·결정으로 정할 수 있는 것은 정하고, 남는 것만 기본값과 함께 미결로 둔다`);
  list('open').forEach((x, i) => {
    const w = `open[${i}]`; claim(x.id, w);
    if (!/^U-\d+$/.test(x.id ?? '')) err(w, 'id 는 U-<번호>');
    if (blank(x.question) || blank(x.default)) err(w, 'question 과 default(정해지기 전까지 따르는 기본값)가 필요함');
  });
  list('changes').forEach((x, i) => { const w = `changes[${i}]`; claim(x.id, w); if (blank(x.change) || blank(x.reason)) err(w, 'change·reason 이 필요함'); (x.sourceRefs ?? []).forEach((r, j) => ref(`${w}.sourceRefs[${j}]`, r)); });
  list('questions').forEach((x, i) => { const w = `questions[${i}]`; claim(x.id, w); if (blank(x.question)) err(w, 'question 이 없음'); });
  list('decisions').forEach((x, i) => { const w = `decisions[${i}]`; claim(x.id, w); if (blank(x.statement) || blank(x.rationale)) err(w, 'statement·rationale 이 필요함'); (x.sourceRefs ?? []).forEach((r, j) => ref(`${w}.sourceRefs[${j}]`, r)); });
  for (const x of list('open')) for (const id of x.impact ?? []) if (!ids.has(id)) err(`open:${x.id}`, `impact 가 없는 id 를 가리킴 — ${id}`);
  list('findings').forEach((f, i) => {
    const w = `findings[${i}]`; claim(f.id, w);
    if (!SEVERITY.includes(f.severity)) err(w, `severity 는 ${SEVERITY.join('|')}`);
    if (!STANCES.includes(f.stance)) err(w, `stance 는 ${STANCES.join('|')}`);
    if (blank(f.message) || blank(f.recommendation)) err(w, 'message·recommendation 이 필요함');
    if (!ids.has(f.target)) err(w, `target 이 가리키는 id 가 없음 — ${f.target}`);
  });
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) { process.stderr.write('usage: node scripts/validate.mjs <case-dir>\n'); process.exit(2); }
  const errors = validate(resolve(dir));
  if (errors.length) { for (const e of errors) process.stderr.write(`${e}\n`); process.exit(1); }
  process.stdout.write('PASS\n');
}
