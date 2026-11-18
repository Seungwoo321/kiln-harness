#!/usr/bin/env node
// design-review 검증 — 요구 조건 → 설계 위치 커버리지, 불변식 반례 추적, 보완안의 결정적 검사. 형식 정본은 FORMAT.md 다.
// usage: node profiles/design-review/validate.mjs <case-dir>
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeResolver } from '../../scripts/lib/locators.mjs';

export const STATUS = ['covered', 'mention-only', 'missing', 'excluded'];
export const SCENARIOS = ['response-loss', 'concurrency', 'retry', 'late-arrival', 'partial-failure'];
export const VERDICTS = ['holds', 'breaks', 'undocumented', 'n/a'];
const STANCES = ['follow-existing', 're-review', 'ask-plan', 'ask-design', 'ask-backend'];
const SEVERITY = ['high', 'medium', 'low'];
const NEEDS_REMEDY = { coverage: ['missing', 'mention-only'], traces: ['breaks', 'undocumented'] };

const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const blank = (v) => !String(v ?? '').trim();

export function validate(caseDir, plan = readJson(join(caseDir, 'workplan.json'))) {
  const out = [];
  const err = (w, m) => out.push(`${w}: ${m}`);
  const registry = readJson(join(caseDir, 'sources.json'));
  const extracts = Object.fromEntries(registry.sources.map((s) => [s.id, existsSync(join(caseDir, 'extract', `${s.id}.json`)) ? readJson(join(caseDir, 'extract', `${s.id}.json`)) : { anchors: [] }]));
  const locators = makeResolver(caseDir, registry, extracts);
  const subjects = new Set(registry.sources.filter((s) => s.role === 'subject').map((s) => s.id));
  const ref = (w, r, onlySubject = false) => {
    if (!r?.sourceId || !r?.locator) return err(w, 'sourceId·locator 가 필요함');
    if (onlySubject && !subjects.has(r.sourceId)) return err(w, `검토 대상 설계 문서(subject)의 위치여야 함 — ${r.sourceId}`);
    const v = locators.resolve(r.sourceId, r.locator);
    if (!v.ok) err(w, v.reason);
  };
  if (plan.kind !== 'DesignReview') err('kind', 'DesignReview 여야 함');
  if ([...plan.inputDigests ?? []].sort().join() !== registry.sources.map((s) => s.sha256).sort().join()) err('inputDigests', '등록된 원본과 다름');

  const ids = new Set();
  const claim = (id, w) => { if (!id || ids.has(id)) err(w, `id 가 없거나 중복 — ${id}`); ids.add(id); };
  const list = (k) => (Array.isArray(plan[k]) ? plan[k] : []);
  for (const k of ['invariants', 'coverage', 'traces', 'remedies', 'questions', 'decisions']) if (plan[k] !== undefined && !Array.isArray(plan[k])) err(k, '배열이어야 함');

  list('invariants').forEach((x, i) => {
    const w = `invariants[${i}]`; claim(x.id, w);
    if (blank(x.statement)) err(w, 'statement 가 없음');
    if (!x.fromBrief) { if (!Array.isArray(x.sourceRefs) || !x.sourceRefs.length) err(w, '원본 위치(sourceRefs) 또는 fromBrief:true 가 필요함'); else x.sourceRefs.forEach((r, j) => ref(`${w}.sourceRefs[${j}]`, r)); }
  });

  // 커버리지: 조건마다 정확히 한 행
  const conditions = new Set((plan.conditions ?? []).map((c) => c.id));
  // 범위 밖은 범위의 제외 항목이 '남는 의무 없음'으로 선언한 조건뿐이다. 의무가 남으면 그 의무를 설계가 처리하는지로 판정한다.
  const outOfScope = new Set((plan.excluded ?? []).filter((x) => !(x.residual?.obligations ?? []).length && String(x.residual?.none ?? '').trim()).flatMap((x) => x.conditions ?? []));
  const rows = new Map();
  list('coverage').forEach((x, i) => {
    const w = `coverage[${i}]`; claim(x.id, w);
    if (!conditions.has(x.condition)) err(w, `범위에 없는 조건 — ${x.condition}`);
    else if (rows.has(x.condition)) err(w, `조건 ${x.condition} 의 행이 둘 이상`);
    rows.set(x.condition, x);
    if (!(x.conditions ?? []).includes(x.condition)) err(w, `conditions 에 자기 조건(${x.condition})이 있어야 함`);
    if (!STATUS.includes(x.status)) err(w, `status 는 ${STATUS.join('|')}`);
    const locs = Array.isArray(x.locations) ? x.locations : [];
    if (['covered', 'mention-only'].includes(x.status) && !locs.length) err(w, `${x.status} 는 검토 대상 문서의 위치(locations)가 필요함`);
    if (x.status === 'missing' && locs.length) err(w, 'missing 은 위치가 없어야 함 — 언급이 있으면 mention-only 다');
    locs.forEach((r, j) => ref(`${w}.locations[${j}]`, r, true));
    if (x.status === 'excluded' && !outOfScope.has(x.condition)) err(w, `excluded 는 범위의 제외 항목이 남는 의무 없음(residual.none)으로 선언한 조건에만 쓴다 — ${x.condition} 은 그 의무를 설계가 처리하는지(covered|mention-only|missing)로 판정한다`);
    if (['mention-only', 'missing', 'excluded'].includes(x.status) && blank(x.note)) err(w, `${x.status} 는 note(무엇이 빠졌는지·왜 범위 밖인지)가 필요함`);
  });
  for (const c of conditions) if (!rows.has(c)) err('coverage', `조건 ${c} 의 커버리지 행이 없음`);

  // 반례 추적: 불변식 × 시나리오마다 정확히 한 행. 불변식이 없으면 추적하지 않는다(미검사로 보인다).
  const invariants = list('invariants').map((x) => x.id);
  if (!invariants.length && list('traces').length) err('traces', '불변식이 없으면 traces 는 비어야 함 — 추적은 지정된 불변식에만 한다');
  const seen = new Set();
  list('traces').forEach((x, i) => {
    const w = `traces[${i}]`; claim(x.id, w);
    if (!invariants.includes(x.invariant)) err(w, `없는 불변식 — ${x.invariant}`);
    if (!SCENARIOS.includes(x.scenario)) err(w, `scenario 는 ${SCENARIOS.join('|')}`);
    const key = `${x.invariant}|${x.scenario}`; if (seen.has(key)) err(w, `같은 불변식·시나리오 행이 둘 이상 — ${key}`); seen.add(key);
    if (!VERDICTS.includes(x.verdict)) err(w, `verdict 는 ${VERDICTS.join('|')}`);
    const steps = Array.isArray(x.steps) ? x.steps : [];
    if (x.verdict === 'n/a') { if (blank(x.reason)) err(w, 'n/a 는 reason 이 필요함'); }
    else if (!steps.length) err(w, '단계별 문서 근거(steps)가 필요함');
    steps.forEach((s, j) => { if (blank(s.state)) err(`${w}.steps[${j}]`, 'state(그 단계에서 문서가 정하는 상태·동작)가 없음'); ref(`${w}.steps[${j}].ref`, s.ref, true); });
    if (x.verdict === 'breaks' && blank(x.counterexample)) err(w, 'breaks 는 counterexample(불변식이 깨지는 경로)이 필요함');
    if (x.verdict === 'undocumented' && blank(x.gap)) err(w, 'undocumented 는 gap(문서만으로 정할 수 없는 다음 상태)이 필요함');
  });
  for (const inv of invariants) for (const sc of SCENARIOS) if (!seen.has(`${inv}|${sc}`)) err('traces', `불변식 ${inv} 의 ${sc} 시나리오 행이 없음 (해당 없으면 verdict:n/a 와 reason)`);

  // 보완안: 누락·언급만·깨짐·미정의마다 하나 이상
  const addressed = new Set(list('remedies').flatMap((x) => x.addresses ?? []));
  list('remedies').forEach((x, i) => {
    const w = `remedies[${i}]`; claim(x.id, w);
    if (blank(x.proposal)) err(w, 'proposal 이 없음');
    if (!Array.isArray(x.addresses) || !x.addresses.length) err(w, 'addresses(해소하는 커버리지·추적 id)가 없음');
  });
  for (const [k, statuses] of Object.entries(NEEDS_REMEDY)) for (const x of list(k)) if (statuses.includes(x.status ?? x.verdict) && !addressed.has(x.id)) err(`${k}:${x.id}`, `${x.status ?? x.verdict} 인데 보완안(remedies)이 없음`);

  list('questions').forEach((x, i) => { const w = `questions[${i}]`; claim(x.id, w); if (blank(x.question)) err(w, 'question 이 없음'); (x.sourceRefs ?? []).forEach((r, j) => ref(`${w}.sourceRefs[${j}]`, r)); });
  list('decisions').forEach((x, i) => { const w = `decisions[${i}]`; claim(x.id, w); if (blank(x.statement) || blank(x.rationale)) err(w, 'statement·rationale 이 필요함'); (x.sourceRefs ?? []).forEach((r, j) => ref(`${w}.sourceRefs[${j}]`, r)); });
  for (const x of list('remedies')) for (const id of x.addresses ?? []) if (!ids.has(id)) err(`remedies:${x.id}`, `addresses 가 없는 id 를 가리킴 — ${id}`);
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
