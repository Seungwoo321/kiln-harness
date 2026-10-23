// 오케스트레이션 본체 — 순서·루프·롤백·상태만 담당한다. 판단은 에이전트가, 합격 판정은 게이트(스크립트)가 한다.
//
// 구조 (content-generator-v9 의 장치를 따른다)
//   단계(S3 scope · S4 interpret · S6 critic) = 사전 정리 → 에이전트 1회성 실행 → 사후 게이트 → 실패 시 위반을 다음 시도에 주입(단계당 최대 stageAttempts)
//   전체 루프 = 한 단계라도 소진되면 파생 산출물을 지우고 처음부터 다시(최대 loopAttempts). 지난 시도의 위반은 교훈으로 넘긴다
//   최종 실패 = 파생 산출물 삭제(원본·결정은 보존), 마지막 시도는 failed/ 에 남기고 run-status.json 에 위반을 적는다
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, cpSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { register, canonical, sha256, previousDir } from '../register.mjs';
import { buildLineage } from '../lineage.mjs';
import { buildCatalog, catalogText } from '../catalog.mjs';
import { extract } from '../extract.mjs';
import { validate } from '../validate.mjs';
import { render } from '../render.mjs';
import { renderReview } from '../render-review.mjs';
import { readDecisions } from '../decide.mjs';
import { runAgent as realRunAgent } from './runner.mjs';
import { createLive, createTicker, logLine } from './live.mjs';
import { DEFAULT_LEVEL, parseLevel, levelBlock } from './levels.mjs';
import { readDesignSpecs } from './design-policy.mjs';
import { BLOCKING, judgmentErrors, groundJudgments, conformanceBrief } from './conformance.mjs';
import { seal } from '../design-spec.mjs';
import { appendConformanceReview } from './conformance-view.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STAGES = ['scope', 'interpret', 'critic'];
const DERIVED = ['stages', 'session.json', 'scope.json', 'workplan.json', 'WORKPLAN.md', 'WORKPLAN.html', 'review.html', 'conformance.json', 'conformance-brief.md'];
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const tryJson = (file) => { try { return readJson(file); } catch { return null; } };

// ── 설정 ────────────────────────────────────────────────────────────────────
export function loadConfig(dir, env = process.env) {
  const base = readJson(join(ROOT, 'kh.config.json'));
  const local = existsSync(join(dir, 'kh.config.json')) ? readJson(join(dir, 'kh.config.json')) : {};
  const level = parseLevel(env.KH_LEVEL ?? local.level ?? base.level ?? DEFAULT_LEVEL);
  const cfg = { level, limits: { ...base.limits, ...local.limits }, stages: {} };
  for (const s of [...STAGES, 'conformance']) {
    const key = s.toUpperCase();
    // runner 가 바뀌면 기본 설정의 model·effort 는 그 runner 의 이름이 아니므로 상속하지 않는다(claude 의 'opus' 를 codex 에 넘기지 않는다).
    const override = { ...local.stages?.[s] };
    if (env[`KH_${key}_RUNNER`]) override.runner = env[`KH_${key}_RUNNER`];
    const sameRunner = !override.runner || override.runner === base.stages[s].runner;
    cfg.stages[s] = sameRunner ? { ...base.stages[s], ...override } : { ...override };
    if (env[`KH_${key}_RUNNER`]) cfg.stages[s].runner = env[`KH_${key}_RUNNER`];
    if (cfg.stages[s].session === undefined) cfg.stages[s].session = base.stages[s].session ?? 'fresh'; // 세션 방식은 runner 와 무관하게 이어받는다
    if (env[`KH_${key}_MODEL`]) cfg.stages[s].model = env[`KH_${key}_MODEL`];
    if (env[`KH_${key}_EFFORT`]) cfg.stages[s].effort = env[`KH_${key}_EFFORT`];
    if (env[`KH_${key}_SESSION`]) cfg.stages[s].session = env[`KH_${key}_SESSION`];
    if (env[`KH_${key}_SESSION`]) cfg.stages[s].session = env[`KH_${key}_SESSION`];
  }
  if (env.KH_MODEL && !env.KH_INTERPRET_MODEL) cfg.stages.interpret.model = env.KH_MODEL; // 이전 인터페이스 호환
  return cfg;
}

// ── 게이트 (결정적) ─────────────────────────────────────────────────────────
const CHANGE = ['new', 'changed'];
function checkRefs(where, refs, sourceIds, out) {
  if (!Array.isArray(refs) || refs.length === 0) return out.push(`${where}: sourceRefs 가 비었음`);
  for (const r of refs) {
    if (!sourceIds.has(r?.sourceId)) out.push(`${where}: 등록되지 않은 sourceId — ${r?.sourceId}`);
    if (!r?.locator) out.push(`${where}: locator 가 없음`);
  }
}

export function scopeGate(dir, registry, lineage = null) {
  const out = [];
  const scope = tryJson(join(dir, 'stages', 'scope.json'));
  if (!scope) return { violations: ['stages/scope.json 이 없거나 JSON 이 아님'] };
  const ids = new Set(registry.sources.map((s) => s.id));
  const used = new Set();
  const collect = (refs) => (Array.isArray(refs) ? refs : []).forEach((r) => used.add(r?.sourceId));
  if (!Array.isArray(scope.surfaces) || scope.surfaces.length === 0) out.push('surfaces 가 비었음 — 이번 작업 화면이 하나도 없다');
  const seen = new Set();
  (scope.surfaces ?? []).forEach((s, i) => {
    const w = `surfaces[${i}]`;
    if (!s.id || seen.has(s.id)) out.push(`${w}: id 가 없거나 중복`);
    seen.add(s.id);
    for (const f of ['title', 'entry']) if (!s[f]) out.push(`${w}: ${f} 가 없음`);
    if (!CHANGE.includes(s.change)) out.push(`${w}: change 는 ${CHANGE.join('|')}`);
    checkRefs(w, s.sourceRefs, ids, out); collect(s.sourceRefs);
    // 후속 사례: 바뀐 원본에 근거가 닿지 않는 화면은 이번 범위가 아니다(버전 관리).
    const unchanged = new Set((lineage?.sources ?? []).filter((x) => x.status === 'unchanged').map((x) => x.sourceId));
    const refsOf = (s.sourceRefs ?? []).map((r) => r?.sourceId).filter((id) => ids.has(id));
    if (lineage && refsOf.length > 0 && refsOf.every((id) => unchanged.has(id))) out.push(`${w}: 이전 사례와 같은 원본만 근거라 이번 범위가 아님 — excluded 로 옮긴다 (${s.id})`);
  });
  (scope.excluded ?? []).forEach((x, i) => {
    const w = `excluded[${i}]`;
    if (!x.title || !x.reason) out.push(`${w}: title·reason 이 필요함`);
    checkRefs(w, x.sourceRefs, ids, out); collect(x.sourceRefs);
  });
  for (const s of registry.sources) {
    if (['plan', 'design'].includes(s.role) && !used.has(s.id)) out.push(`입력이 범위 판단에 쓰이지 않음 — ${s.id} (surfaces 또는 excluded 의 sourceRefs 에 나타나야 함)`);
  }
  return { violations: out, value: scope };
}

const ENVELOPE = ['schemaVersion', 'kind', 'caseId', 'inputDigests', 'findings', 'level'];
export function assemblePlan(registry, draft, findings = [], level = DEFAULT_LEVEL) {
  const body = Object.fromEntries(Object.entries(draft).filter(([k]) => !ENVELOPE.includes(k)));
  return { schemaVersion: 3, kind: 'WorkPlan', caseId: registry.caseId, inputDigests: registry.sources.map((s) => s.sha256), level, ...body, findings };
}

export function interpretGate(dir, registry, scope, level = DEFAULT_LEVEL) {
  const draft = tryJson(join(dir, 'stages', 'workplan.draft.json'));
  if (!draft) return { violations: ['stages/workplan.draft.json 이 없거나 JSON 이 아님'] };
  const out = [];
  const want = new Set(scope.surfaces.map((s) => s.id));
  const got = new Set((draft.surfaces ?? []).map((s) => s.id));
  for (const id of want) if (!got.has(id)) out.push(`범위의 화면이 계획서에 없음 — ${id}`);
  for (const id of got) if (!want.has(id)) out.push(`범위에 없는 화면을 추가함 — ${id}`);
  const plan = assemblePlan(registry, draft, [], level);
  const specs = readDesignSpecs(dir, registry);
  plan.designSpecDigests = specs.map(s => s.digest);
  for (const row of plan.designSpecs ?? []) {
    const spec = specs.find(s => s.sourceId === row.sourceId);
    row.observation = spec?.elements.find(e => e.id === row.element) ?? spec?.interactions.find(i => i.id === row.element) ?? null;
  }
  out.push(...validate(dir, plan));
  return { violations: out, value: plan };
}

// 원본이 이미 답한 질문은 질문이 아니라 결정(decisions)으로 내린다 — 비평이 'demote' 로 판정하고 근거(decision)를 단 질문이 대상이다.
// 그 질문에 기대던 추론 항목은 같은 근거를 단 원본 근거 항목이 되고, 연쇄 참조(영향·covers·지적·계보)도 함께 정리한다.
export function applyQuestionVerdicts(plan, demoted, dropped) {
  if (demoted.size === 0 && dropped.size === 0) return plan;
  const next = JSON.parse(JSON.stringify(plan));
  const gone = new Set([...demoted.keys(), ...dropped]);
  const dedupe = (refs) => [...new Map(refs.map((r) => [`${r.sourceId}|${r.locator}`, r])).values()];
  next.questions = (next.questions ?? []).filter((q) => !gone.has(q.id));
  next.decisions = [...(next.decisions ?? []), ...[...demoted].map(([qid, d]) => ({ id: `D-${qid}`, ...d }))];
  for (const key of ['requirements', 'states']) {
    for (const item of next[key] ?? []) {
      if (item.basis === 'inferred' && demoted.has(item.question)) {
        item.sourceRefs = dedupe([...(item.sourceRefs ?? []), ...demoted.get(item.question).sourceRefs]);
        item.decision = `D-${item.question}`;
        item.basis = demoted.get(item.question).kind === 'fitted' ? 'fitted' : 'source';
        delete item.question;
      }
    }
  }
  for (const q of next.questions) q.impact = (q.impact ?? []).filter((id) => !gone.has(id));
  for (const task of next.tasks ?? []) task.covers = (task.covers ?? []).filter((id) => !gone.has(id));
  for (const x of next.lineage?.resolved ?? []) {
    if (x.status === 'still-open' && demoted.has(x.question)) {
      x.status = 'resolved'; x.evidence = demoted.get(x.question).sourceRefs; x.note = `${x.note} (비평 단계에서 원본이 이미 답한 것으로 확인 — D-${x.question})`; delete x.question;
    } else if (x.status === 'still-open' && dropped.has(x.question)) {
      x.status = 'obsolete'; x.note = `${x.note} (비평 단계에서 질문 제거)`; delete x.question;
    }
  }
  return next;
}

export function criticGate(dir, registry, plan) {
  const crit = tryJson(join(dir, 'stages', 'critic.json'));
  if (!crit || !Array.isArray(crit.findings)) return { violations: ['stages/critic.json 이 없거나 findings 배열이 없음'] };
  const out = [];
  crit.findings.forEach((f, i) => { if (!f.evidence) out.push(`findings[${i}]: evidence(원본·코드 위치 근거)가 없음`); });

  // 질문마다 판정이 있어야 한다 — keep(기준에 맞음) · demote(원본이 이미 답함 → decision) · drop(중복·내용 없음).
  const verdicts = Array.isArray(crit.questionVerdicts) ? crit.questionVerdicts : [];
  const qids = (plan.questions ?? []).map((q) => q.id);
  const lineageConflicts = new Set((plan.lineage?.inherited ?? []).filter((x) => x.status === 'conflict').map((x) => x.question));
  const designConflicts = new Set((plan.questions ?? []).filter(q => q.designEvidence).map(q => q.id));
  const inferredTargets = new Set([...(plan.requirements ?? []), ...(plan.states ?? [])].filter((x) => x.basis === 'inferred').map((x) => x.question));
  const demoted = new Map();
  const dropped = new Set();
  for (const id of qids) if (verdicts.filter((v) => v.id === id).length !== 1) out.push(`questionVerdicts: 질문 ${id} 의 판정이 정확히 하나여야 함`);
  verdicts.forEach((v, i) => {
    const w = `questionVerdicts[${i}]`;
    if (!qids.includes(v.id)) return out.push(`${w}: 계획서에 없는 질문 — ${v.id}`);
    if (!['keep', 'demote', 'drop'].includes(v.verdict)) return out.push(`${w}: verdict 는 keep|demote|drop`);
    if (v.verdict === 'keep') return undefined;
    if (lineageConflicts.has(v.id)) return out.push(`${w}: 이전 결정과의 충돌 질문은 내리거나 제거할 수 없음 — ${v.id}`);
    if (designConflicts.has(v.id)) return out.push(`${w}: 시안 동작 충돌 질문은 내리거나 제거할 수 없음 — ${v.id}`);
    if (v.verdict === 'drop') {
      if (!v.reason) out.push(`${w}: drop 은 reason 이 필요함`);
      if (inferredTargets.has(v.id)) out.push(`${w}: 추론 항목이 가리키는 notice 질문은 제거할 수 없음 — demote 하거나 keep 한다 (${v.id})`);
      dropped.add(v.id);
      return undefined;
    }
    const d = v.decision;
    if (!d || typeof d !== 'object') return out.push(`${w}: demote 는 decision{kind, statement, rationale, sourceRefs} 이 필요함`);
    demoted.set(v.id, { kind: d.kind, statement: d.statement, rationale: d.rationale, sourceRefs: Array.isArray(d.sourceRefs) ? d.sourceRefs : [] });
    return undefined;
  });
  if (out.length) return { violations: out };

  const applied = applyQuestionVerdicts(plan, demoted, dropped);
  const gone = new Set([...demoted.keys(), ...dropped]);
  if ((plan.level ?? DEFAULT_LEVEL) >= 8) {
    // 체계 검증: 화면마다 어떤 원본끼리 대조했는지 남아야 한다 — 대조 없이 통과시키지 않는다.
    const cov = Array.isArray(crit.coverage) ? crit.coverage : [];
    const need = registry.sources.filter((x) => ['plan', 'design', 'contract'].includes(x.role)).map((x) => x.id);
    for (const sf of plan.surfaces ?? []) {
      const c = cov.find((x) => x.surface === sf.id);
      if (!c) { out.push(`coverage: 화면 ${sf.id} 의 대조 기록이 없음`); continue; }
      const got = new Set(Array.isArray(c.sourcesCompared) ? c.sourcesCompared : []);
      for (const id of need) if (!got.has(id)) out.push(`coverage: 화면 ${sf.id} 에서 ${id} 와 대조하지 않음`);
      if (!c.result) out.push(`coverage: 화면 ${sf.id} 의 result 가 없음`);
    }
    if (out.length) return { violations: out };
  }
  const merged = { ...applied, findings: crit.findings.filter((f) => !gone.has(f.target)), ...((plan.level ?? DEFAULT_LEVEL) >= 8 ? { coverage: crit.coverage } : {}) };
  out.push(...validate(dir, merged)); // 내려온 decision 의 근거·남긴 질문의 기준(두 원본 위치·증거·찾아본 범위)은 여기서 결정적으로 검사된다
  return { violations: out, value: merged, removed: [...gone] };
}

// 에이전트가 원본을 건드렸는지 — 파일 원본의 해시가 등록 시점과 같아야 한다.
export function sourcesIntact(registry) {
  return registry.sources.filter((s) => s.kind !== 'code' && existsSync(s.path) && sha256(readFileSync(s.path)) !== s.sha256).map((s) => `원본이 수정됨 — ${s.id}`);
}

// ── 프롬프트 ────────────────────────────────────────────────────────────────
const feedbackBlock = (title, items) => (items.length ? `\n\n[${title}]\n${items.map((e) => `- ${e}`).join('\n')}` : '');
const role = (name) => readFileSync(join(ROOT, 'roles', `${name}.md`), 'utf8');

function lineageBlock(stage, lin) {
  const head = `\n\n[후속 사례] 이전 사례 ${lin.previous.caseId} 의 후속 작업이다. 자세한 대조 결과는 lineage.json, 이전 기록은 이전 사례 폴더(${lin.previous.case})에 있다.\n- 현재 상태의 정본은 sources.json 이 고정한 실제 코드다. 결정 근거의 정본은 이전 사례의 기록(결정·열린 확인 요청·추론 항목)이다.`;
  const diff = lin.sources.map((s) => `  · ${s.sourceId}: ${s.status}${s.changedRegions ? ` (바뀐 영역 ${s.changedRegions.length}개)` : ''}${s.added ? ` (추가 앵커 ${s.added.length}, 제거 ${s.removed.length})` : ''}`).join('\n');
  if (stage === 'scope') return `${head}\n- 이전 원본과 대조한 결과(원본별 상태):\n${diff}\n- 범위는 바뀐 영역(changedRegions)·추가 앵커에서만 잡는다. 변경 없는 원본·영역은 excluded 에 '변경 없음' 으로 둔다.`;
  if (stage === 'interpret') {
    return `${head}\n- 이전 결정 ${lin.decisions.length}건은 확정값이다 — 계획서의 lineage.inherited 에 결정마다 {ref, status: kept|conflict|obsolete, note, target?, question?} 로 처리 결과를 적는다. 새 기획이 결정과 어긋날 때만 status:conflict 로 두고 questions 로 올린다 (예: 기획은 부분 마스킹, 이전 결정은 전체 마스킹이면 '누락(gap)'으로 되돌리지 말고 질문으로 올린다).\n- 이전 열린 확인 요청 ${lin.openQuestions.length}건은 새 원본·코드로 해소됐는지 대조해 lineage.resolved 에 {ref, status: resolved|still-open|obsolete, note, evidence(sourceRefs)?, question?} 로 적는다. resolved 는 근거(evidence)가 필수다.\n- lineage = { previous: "${lin.previous.caseId}", inherited: [...], resolved: [...] }`;
  }
  return `${head}\n- 이전 결정을 계획서가 gap 이나 누락으로 되돌린 곳, 이어받았다고 적고 실제로는 어긋난 곳, 해소됐다는 근거가 약한 곳을 지적한다.`;
}

export function buildPrompt(stage, ctx) {
  if (stage === 'conformance') return `conformance-facts.json의 사실만 근거로 구현 적합성을 판단한다. 모든 fact id를 정확히 한 번 판정한다. 결과는 stages/conformance.json이다. 형식은 역할 파일을 따른다. 컴포넌트 대응·수용 여부를 직접 판단하고 수집 스크립트의 후보나 오차를 정답으로 취급하지 않는다.${feedbackBlock('이전 시도의 형식 위반', ctx.feedback)}`;
  const head = `사례 폴더(작업 디렉터리)에서 작업한다. 읽을 파일: sources.json, extract/*.json, references.json. 역할 파일의 입출력 계약을 따른다.${ctx.catalog ? catalogText(ctx.catalog) : ''}`;
  const lin = ctx.lineage ? lineageBlock(stage, ctx.lineage) : '';
  const design = ctx.catalog?.designSpec;
  const evidence = design ? `\n\n[렌더 증거]\ndesign-spec: ${design.status}${design.reason ? ` (${design.reason})` : ''}. ${JSON.stringify(design.sources ?? [])}\n${JSON.stringify(design.summary ?? [])}\n전체 요소·계산 스타일: design-spec/<sourceId>.json. 컴포넌트 기준: component-baseline.json. 기존 UI 사용례: existing-patterns.json (${ctx.catalog.existingPatterns ?? 0}개, 적합성은 코드로 확인). 출처별 수용 정책과 v3 시안 규격을 적용한다.` : '';
  const tail = lin + evidence + levelBlock(stage, ctx.level ?? DEFAULT_LEVEL) + feedbackBlock('이전 시도의 위반 — 모두 해소한다', ctx.feedback) + feedbackBlock('지난 전체 시도에서 배운 것 — 같은 실수를 반복하지 않는다', ctx.lessons);
  if (stage === 'scope') return `${head}\n결과: stages/scope.json${tail}`;
  if (stage === 'interpret') {
    const decisions = ctx.decisions.length ? `\n\n[사용자 결정 — 확정값]\n${ctx.decisions.map((d) => `- ${d.id} (${d.stance}): ${d.note}`).join('\n')}` : '';
    const base = ctx.basePlan ? '\n\n기존 계획서가 workplan.json 에 있다. 이를 바탕으로, 위 결정이 가리키는 항목과 그에 영향받는 항목만 고치고 나머지는 그대로 둔다.' : '';
    return `${head}\n범위: stages/scope.json. 계획서 형식: ${join(ROOT, 'docs', 'workplan-format.md')} (v2·v3 절 포함).\n결과: stages/workplan.draft.json${base}${decisions}${tail}`;
  }
  return `${head}\n검토 대상: stages/workplan.checked.json (해석 게이트를 통과한 계획서). 사용자 결정: decisions.json (없으면 결정 없음). 이전 사례 기록이 있으면 lineage.json.\n결과: stages/critic.json — findings 와 questionVerdicts(모든 질문)${tail}`;
}

// ── 단계 실행 ───────────────────────────────────────────────────────────────
function addDirs(dir, registry) {
  const prev = registry.lineage ? [previousDir(dir, registry.lineage.case)] : [];
  return [...new Set([ROOT, ...prev, ...registry.sources.map((s) => (s.kind === 'code' ? s.repo : dirname(s.path)))])];
}

function gitRepos(registry) {
  return [...new Set(registry.sources.filter((s) => s.kind === 'code').map((s) => s.repo))];
}

// 같은 주제(사례) 안에서는 세션 id 로 이전 컨텍스트를 잇는다. 오케스트레이터가 UUID 를 정해 첫 호출은 새 세션으로, 이후는 같은 id 로 이어간다.
// session:'fresh' 인 단계(기본: critic — 생산자≠검증자)는 항상 1회성 새 세션이다.
function sessionFor(cfg, chain) {
  if (cfg.session !== 'chain') return undefined;
  const id = chain.ids[cfg.runner];
  if (id && chain.started[cfg.runner]) return { mode: 'resume', id };
  return { mode: 'new', id: cfg.runner === 'claude' ? randomUUID() : undefined };
}

export function runStage({ name, dir, registry, cfg, limits, deps, ctx, gate, outFile, stat, chain }) {
  let feedback = [];
  for (let n = 1; n <= limits.stageAttempts; n += 1) {
    if (outFile) rmSync(join(dir, 'stages', outFile), { force: true });
    deps.log(name, `시도 ${n}/${limits.stageAttempts}${feedback.length ? ` (위반 ${feedback.length}건 반영)` : ''} · ${cfg.runner}/${cfg.model ?? '기본'}${cfg.effort ? `/${cfg.effort}` : ''}`);
    const session = sessionFor(cfg, chain);
    const res = deps.runAgent({ runner: cfg.runner, model: cfg.model, effort: cfg.effort, role: role(name), prompt: buildPrompt(name, { ...ctx, feedback }), cwd: dir, addDirs: addDirs(dir, registry), gitRepos: gitRepos(registry), timeoutSec: limits.timeoutSec, session, logName: `${name}-${n}`,
      onTick: deps.tick ? (t) => deps.tick({ stage: name, attempt: n, max: limits.stageAttempts, cfg, ...t }) : undefined });
    deps.tickEnd?.();
    if (session) {
      const id = res.sessionId ?? session.id;
      if (res.ok && id) { chain.ids[cfg.runner] = id; chain.started[cfg.runner] = true; } else if (session.mode === 'resume') { delete chain.ids[cfg.runner]; chain.started[cfg.runner] = false; } // 이어가기에 실패하면 다음 시도는 새 세션
      writeFileSync(join(dir, 'session.json'), `${JSON.stringify({ ...chain.ids }, null, 2)}\n`);
    }
    stat.calls += 1; stat.tokens += res.tokens ?? 0; stat.seconds += res.seconds ?? 0; stat.costUsd += res.costUsd ?? 0;
    if (!res.ok) { feedback = [`에이전트 실행 실패: ${res.error}`]; deps.log(name, feedback[0]); continue; }
    const missing = Array.isArray(res.status?.missingInputs) ? res.status.missingInputs.filter(Boolean) : [];
    // 필요한 자료가 입력에 없다는 알림은 재시도로 풀리지 않는다 — 입력 보강을 요청하고 멈춘다.
    if (res.status?.status === 'blocked' && missing.length) { deps.log(name, `입력 보강 필요: ${missing.join(' / ')}`); return { ok: false, attempts: n, needsInput: missing, violations: [] }; }
    if (res.status?.status === 'blocked') { feedback = [`에이전트가 멈춤: ${res.status.message}`]; deps.log(name, feedback[0]); continue; }
    const intact = sourcesIntact(registry);
    if (intact.length) { feedback = intact; deps.log(name, `원본 수정 감지: ${intact.join(', ')}`); continue; }
    const g = gate();
    if (g.violations.length === 0) { deps.log(name, `통과 (${n}회째)`); return { ok: true, attempts: n, value: g.value, removed: g.removed ?? [] }; }
    feedback = g.violations;
    deps.log(name, `게이트 위반 ${g.violations.length}건`);
  }
  return { ok: false, attempts: limits.stageAttempts, violations: feedback };
}

// ── 상태 ────────────────────────────────────────────────────────────────────
const writeStatus = (dir, body) => writeFileSync(join(dir, 'run-status.json'), `${JSON.stringify({ schemaVersion: 3, ...body, 'design-spec': tryJson(join(dir, 'design-spec-status.json')) }, null, 2)}\n`);
const newStat = () => ({ calls: 0, tokens: 0, seconds: 0, costUsd: 0 });

function snapshotFailed(dir, loop, violations) {
  const to = join(dir, 'failed', `loop-${loop}`);
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  if (existsSync(join(dir, 'stages'))) cpSync(join(dir, 'stages'), join(to, 'stages'), { recursive: true });
  writeFileSync(join(to, 'violations.json'), `${JSON.stringify(violations, null, 2)}\n`);
}

const discard = (dir) => { for (const f of DERIVED) rmSync(join(dir, f), { recursive: true, force: true }); };

function upToDate(dir, registry, decisionsDigest, level) {
  const status = tryJson(join(dir, 'run-status.json'));
  const plan = tryJson(join(dir, 'workplan.json'));
  if (!status || !plan || status.result !== 'passed' || status.decisionsDigest !== decisionsDigest || (status.level ?? DEFAULT_LEVEL) !== level) return false;
  if (plan.schemaVersion < 2 || !Array.isArray(plan.findings)) return false;
  if (plan.schemaVersion < 3 && readDesignSpecs(dir, registry).length) return false;
  return [...plan.inputDigests].sort().join() === registry.sources.map((s) => s.sha256).sort().join() && validate(dir).length === 0;
}

const itemIds = (plan) => new Map(['surfaces', 'requirements', 'states', 'components', 'apiBindings', 'gaps', 'questions', 'tasks'].flatMap((k) => (plan?.[k] ?? []).map((i) => [i.id, sha256(canonical(i))])));
export const changedIds = (before, after) => { const a = itemIds(before); const b = itemIds(after); return [...b.keys()].filter((id) => a.get(id) !== b.get(id)).concat([...a.keys()].filter((id) => !b.has(id))).sort(); };

// ── 파이프라인 ──────────────────────────────────────────────────────────────
export function runPipeline(rawDir, opts = {}, injected = {}) {
  const dir = resolve(rawDir);
  const live = createLive();
  const deps = { runAgent: injected.runAgent ?? realRunAgent, log: injected.log ?? ((s, m) => live.print(logLine(live.color, s, m))) };
  const cfg = loadConfig(dir, opts.env ?? process.env);
  const level = opts.level !== undefined ? parseLevel(opts.level) : cfg.level;
  const limits = { ...cfg.limits, ...(opts.stageAttempts ? { stageAttempts: opts.stageAttempts } : {}), ...(opts.loopAttempts ? { loopAttempts: opts.loopAttempts } : {}) };

  const registry = register(dir);
  deps.log('S1', `원본 ${registry.sources.length}건 · digest ${registry.digest.slice(0, 12)}`);
  const extracted = extract(dir);
  deps.log('S2', `앵커 ${extracted.reduce((n, x) => n + x.anchors, 0)}개`);
  try {
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'design-spec.mjs'), dir], { env: { ...process.env, ...opts.env }, timeout: 600000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const violation = `S2d 렌더 실패: ${e.stderr?.toString() || e.message}`;
    writeFileSync(join(dir, 'design-spec-status.json'), `${JSON.stringify(seal({ schemaVersion: 1, kind: 'DesignSpecStatus', status: 'failed', reason: violation, sources: [] }), null, 2)}\n`);
    writeStatus(dir, { stage: 'design-spec', result: 'failed', violations: [violation] });
    return { ok: false, violations: [violation] };
  }
  const designStatus = readJson(join(dir, 'design-spec-status.json'));
  deps.log('S2d', `design-spec: ${designStatus.status}${designStatus.reason ? ` (${designStatus.reason})` : ''}`);
  rmSync(join(dir, 'lineage.json'), { force: true });
  const catalog = buildCatalog(dir);
  deps.log('S2c', `참조 카탈로그: ${catalog.sources.length}건${catalog.missingRoles.length ? ` · 없는 역할 ${catalog.missingRoles.join(', ')}` : ''}`);
  const lineage = registry.lineage ? buildLineage(dir) : null;
  if (lineage) deps.log('S2b', `계보: 이전 ${lineage.previous.caseId} · 결정 ${lineage.decisions.length} · 열린 확인 요청 ${lineage.openQuestions.length} · 원본 ${lineage.sources.map((s) => `${s.sourceId}:${s.status}`).join(' ')}`);

  // 주제 세션: 이전 실행에서 이어받는다(결정만 바뀐 재실행은 같은 대화를 잇는다). --force·처음부터 다시 시작이면 새 세션이다.
  const savedSessions = opts.force ? {} : (tryJson(join(dir, 'session.json')) ?? {});
  const chain = { ids: { ...savedSessions }, started: Object.fromEntries(Object.keys(savedSessions).map((k) => [k, true])) };
  const decisions = readDecisions(dir);
  const decisionsDigest = sha256(canonical(decisions));
  const prev = tryJson(join(dir, 'run-status.json'));
  const prevPlan = tryJson(join(dir, 'workplan.json'));

  if (!opts.force && upToDate(dir, registry, decisionsDigest, level)) {
    deps.log('S3·S4·S6', '원본·결정·검토 수준이 그대로이고 현재 작업계획이 검증을 통과한다 — 다시 해석하지 않는다');
    render(dir); renderReview(dir);
    writeStatus(dir, { ...prev, 'design-spec': designStatus });
    return { ok: true, skipped: true };
  }

  // 결정만 바뀌었으면(원본 동일) 범위(scope.json)와 기존 계획서를 이어받아 해당 항목만 다시 해석한다.
  const sameSources = prev?.sourcesDigest === registry.digest;
  const levelChanged = prev && (prev.level ?? DEFAULT_LEVEL) !== level;
  if (levelChanged) deps.log('LEVEL', `검토 수준이 ${prev.level ?? DEFAULT_LEVEL} → ${level} 로 바뀌어 계획서를 처음부터 다시 해석한다(범위는 이어받는다)`);
  deps.log('LEVEL', `검토 수준 ${level}/10`);
  const reuseScope = !opts.force && sameSources && existsSync(join(dir, 'scope.json')) && prevPlan?.schemaVersion >= 2;
  const baseScope = reuseScope ? readJson(join(dir, 'scope.json')) : null;

  const stats = Object.fromEntries(STAGES.map((s) => [s, { ...newStat(), result: 'pending' }]));
  if (!injected.runAgent && !injected.log) {
    // 실제 실행(테스트가 아님)일 때만 터미널에 진행 상황을 그린다.
    const startedAt = Date.now();
    const ticker = createTicker({ live, root: dir, overview: () => ({ level, startedAt, stages: STAGES.map((s) => [s, stats[s].result]), totals: usage() }) });
    deps.tick = ticker.tick; deps.tickEnd = ticker.end;
  }
  const usage = () => STAGES.reduce((m, s) => ({ calls: m.calls + stats[s].calls, tokens: m.tokens + stats[s].tokens, seconds: m.seconds + stats[s].seconds, costUsd: Math.round((m.costUsd + stats[s].costUsd) * 1e4) / 1e4 }), newStat());
  let lessons = [];
  let lastViolations = [];

  for (let loop = 1; loop <= limits.loopAttempts; loop += 1) {
    deps.log('LOOP', `전체 시도 ${loop}/${limits.loopAttempts}`);
    const useBase = loop === 1 && reuseScope;
    const basePlan = useBase && !levelChanged ? prevPlan : null;
    if (!useBase) { discard(dir); chain.ids = {}; chain.started = {}; } else { rmSync(join(dir, 'stages'), { recursive: true, force: true }); }
    mkdirSync(join(dir, 'stages'), { recursive: true });
    writeStatus(dir, { stage: 'running', loop, result: 'running', sourcesDigest: registry.digest, level, decisionsDigest, stages: stats });

    const needInput = (name, r) => {
      stats[name].result = 'needs-input';
      writeStatus(dir, { stage: name, loop, result: 'needs-input', sourcesDigest: registry.digest, level, decisionsDigest, stages: stats, usage: usage(), missingInputs: r.needsInput });
      deps.log('INPUT', `입력 보강이 필요해 멈춘다 — inputs.json 에 자료를 더하고 다시 실행한다:\n  · ${r.needsInput.join('\n  · ')}`);
      return { ok: false, needsInput: r.needsInput };
    };
    const fail = (stage, r) => {
      stats[stage].result = 'failed'; lastViolations = r.violations;
      snapshotFailed(dir, loop, { stage, violations: r.violations });
      lessons = [...lessons, ...r.violations.slice(0, 8).map((v) => `[${stage}] ${v}`)].slice(-16);
      deps.log('LOOP', `${stage} 단계가 ${r.attempts}회 안에 통과하지 못했다 — 파생 산출물을 지우고 처음부터 다시 시작한다`);
    };
    const stage = (name, extra) => {
      const r = runStage({ name, dir, registry, cfg: cfg.stages[name], limits, deps, ctx: { decisions, lessons, basePlan, lineage, catalog, level, ...extra.ctx }, gate: extra.gate, outFile: extra.outFile, stat: stats[name], chain });
      stats[name].result = r.ok ? 'passed' : 'failed'; stats[name].attempts = r.attempts;
      writeStatus(dir, { stage: name, loop, result: 'running', sourcesDigest: registry.digest, level, decisionsDigest, stages: stats }); // 단계마다 기록 — 중단돼도 어디까지 갔는지 남는다
      return r;
    };

    // S3
    let scope = baseScope;
    if (scope) { stats.scope.result = 'reused'; mkdirSync(join(dir, 'stages'), { recursive: true }); writeFileSync(join(dir, 'stages', 'scope.json'), `${JSON.stringify(scope, null, 2)}\n`); deps.log('S3', '원본이 그대로라 이전 범위(scope.json)를 이어받는다'); }
    else {
      const r = stage('scope', { gate: () => scopeGate(dir, registry, lineage), outFile: 'scope.json', ctx: {} });
      if (r.needsInput) return needInput('scope', r);
      if (!r.ok) { fail('scope', r); continue; }
      scope = r.value; stats.scope.result = 'passed';
    }
    // S4 (+S5 validate 는 게이트 안에서)
    const ri = stage('interpret', { gate: () => interpretGate(dir, registry, scope, level), outFile: 'workplan.draft.json', ctx: {} });
    if (ri.needsInput) return needInput('interpret', ri);
    if (!ri.ok) { fail('interpret', ri); continue; }
    stats.interpret.result = 'passed';
    // S6 — 비평은 해석 게이트를 통과한 계획서를 읽는다(최종 workplan.json 은 비평까지 통과한 뒤에 쓴다)
    writeFileSync(join(dir, 'stages', 'workplan.checked.json'), `${JSON.stringify(ri.value, null, 2)}\n`);
    const rc = stage('critic', { gate: () => criticGate(dir, registry, ri.value), outFile: 'critic.json', ctx: {} });
    if (rc.needsInput) return needInput('critic', rc);
    if (!rc.ok) { fail('critic', rc); continue; }
    stats.critic.result = 'passed';

    const plan = rc.value;
    const finalErrors = validate(dir, plan);
    if (finalErrors.length) { fail('critic', { attempts: 0, violations: finalErrors }); continue; }
    writeFileSync(join(dir, 'workplan.json'), `${JSON.stringify(plan, null, 2)}\n`);
    writeFileSync(join(dir, 'scope.json'), `${JSON.stringify(scope, null, 2)}\n`);
    render(dir); renderReview(dir);
    writeStatus(dir, { stage: 'done', loop, result: 'passed', sourcesDigest: registry.digest, level, decisionsDigest, workplanDigest: sha256(canonical(plan)), stages: stats, usage: usage(), changedIds: changedIds(prevPlan, plan), removedQuestions: rc.removed });
    deps.log('S7', `${join(dir, 'review.html')}`);
    return { ok: true, loop, plan };
  }

  discard(dir);
  writeStatus(dir, { stage: 'failed', loop: limits.loopAttempts, result: 'failed', sourcesDigest: registry.digest, level, decisionsDigest, stages: stats, usage: usage(), violations: lastViolations });
  deps.log('LOOP', `전체 ${limits.loopAttempts}회 안에 통과하지 못했다 — 파생 산출물을 삭제했다(원본·결정은 보존). 마지막 시도는 failed/ 에 있다`);
  return { ok: false, violations: lastViolations };
}

export const listFailed = (dir) => (existsSync(join(dir, 'failed')) ? readdirSync(join(dir, 'failed')) : []);

export function conformanceGate(dir, facts) {
  const draft = tryJson(join(dir, 'stages', 'conformance.json'));
  const violations = judgmentErrors(draft, facts);
  return { violations, value: violations.length ? draft : groundJudgments(draft, facts) };
}

// S8의 의미 판정은 이 러너가 별도 역할 세션으로 실행한다.
export function runConformance(rawDir, opts = {}, injected = {}) {
  const dir = resolve(rawDir); const facts = readJson(join(dir, 'conformance-facts.json'));
  const { digest, ...body } = facts;
  if (sha256(canonical(body)) !== digest) throw new Error('conformance-facts digest 불일치');
  if (!Array.isArray(facts.facts) || !facts.facts.length) throw new Error('판정할 렌더·코드 사실이 없음');
  const cfg = loadConfig(dir, opts.env ?? process.env);
  const fingerprint = sha256(canonical({ facts: digest, role: role('conformance'), contract: sha256(readFileSync(new URL('./conformance.mjs', import.meta.url))), config: cfg.stages.conformance }));
  const save = (report) => {
    writeFileSync(join(dir, 'conformance.json'), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(dir, 'conformance-brief.md'), conformanceBrief(report));
    appendConformanceReview(dir, report);
    return { ok: report.status === 'passed', needsInput: report.status === 'needs-judgment' ? [report.reason] : undefined, report };
  };
  const old = tryJson(join(dir, 'conformance.json'));
  const oldBody = old ? Object.fromEntries(Object.entries(old).filter(([k]) => k !== 'digest')) : null;
  if (!opts.force && old?.judgmentFingerprint === fingerprint && sha256(canonical(oldBody)) === old.digest && old.status === (old.rows.some(r => BLOCKING.has(r.verdict)) ? 'failed' : 'passed') && judgmentErrors(old, facts).length === 0) return save(old);
  const registry = readJson(join(dir, 'sources.json'));
  mkdirSync(join(dir, 'stages'), { recursive: true });
  const stat = newStat();
  const r = runStage({ name: 'conformance', dir, registry, cfg: { ...cfg.stages.conformance, session: 'fresh' }, limits: cfg.limits, deps: { runAgent: injected.runAgent ?? realRunAgent, log: injected.log ?? ((s, m) => process.stdout.write(`[${s}] ${m}\n`)) }, ctx: {}, gate: () => conformanceGate(dir, facts), outFile: 'conformance.json', stat, chain: { ids: {}, started: {} } });
  const rows = r.ok ? r.value.rows : [];
  const status = r.ok ? rows.some(x => BLOCKING.has(x.verdict)) ? 'failed' : 'passed' : 'needs-judgment';
  const report = { schemaVersion: 1, kind: 'Conformance', status, factsDigest: digest, inputDigests: facts.inputDigests, judgmentFingerprint: fingerprint, rows, facts: facts.facts,
    ...(r.ok ? {} : { reason: r.needsInput?.join(' / ') ?? r.violations.join('\n') }), counts: Object.fromEntries([...new Set(rows.map(x => x.verdict))].sort().map(v => [v, rows.filter(x => x.verdict === v).length])) };
  report.digest = sha256(canonical(report));
  writeStatus(dir, { ...tryJson(join(dir, 'run-status.json')), conformance: { result: status, factsDigest: digest, attempts: r.attempts, usage: stat, violations: r.violations ?? [] } });
  return save(report);
}
