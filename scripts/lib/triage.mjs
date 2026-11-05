// 증분 리뷰 — 입력이 바뀐 재실행에서 이전 실행의 스냅샷과 현재 입력을 비교해 delta 를 만들고,
// LLM 의 triage 판정(skip·incremental·rewrite)에 결정적 가드레일을 건다. 이 파일은 파일 입출력과 순수 판정만 담고,
// 에이전트 호출과 단계 순서는 pipeline.mjs 가 맡는다.
//   history/<runId>/  성공한 실행의 스냅샷(meta.json · scope.json · workplan.json · critic.json)
//   delta.json        이전 스냅샷 대비 추가·변경·삭제된 입력과 영향 후보 항목 id
//   triage.json       판정·근거·적용된 가드레일 (run-status.json 에도 실린다)
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, sha256 } from '../register.mjs';

export const DEFAULTS = { maxChangedRatio: 0.5, maxRemoved: 1, keepRuns: 10 };
export const SCOPE_ROLES = ['plan', 'design']; // 범위(scope.json)의 경계를 정하는 입력 — 바뀌면 범위부터 다시 잡는다
export const SECTIONS = ['surfaces', 'requirements', 'states', 'components', 'apiBindings', 'gaps', 'questions', 'tasks'];
export const ACTIONS = ['skip', 'incremental', 'rewrite'];

const tryJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

// 항목 id → 내용 digest. 증분 게이트가 "영향받지 않은 항목이 그대로인가"를 바이트(정규형) 단위로 비교하는 기준이다.
export const itemIds = (plan) => new Map(SECTIONS.flatMap((k) => (plan?.[k] ?? []).map((i) => [i.id, sha256(canonical(i))])));

// ── 스냅샷 ──────────────────────────────────────────────────────────────────
const runs = (dir) => (existsSync(join(dir, 'history')) ? readdirSync(join(dir, 'history')).filter((n) => /^\d{3,}-[0-9a-f]{8}$/.test(n)).sort() : []);

export function latestSnapshot(dir) {
  const runId = runs(dir).at(-1);
  if (!runId) return null;
  const base = join(dir, 'history', runId);
  const meta = tryJson(join(base, 'meta.json')); const plan = tryJson(join(base, 'workplan.json'));
  if (!meta || !plan) return null;
  return { runId, meta, plan, scope: tryJson(join(base, 'scope.json')), critic: tryJson(join(base, 'critic.json')) };
}

// 성공한 실행 결과를 보존한다. 같은 계획서가 이미 마지막 스냅샷이면 만들지 않는다.
export function snapshotRun(dir, { registry, plan, level, decisionsDigest, keep = DEFAULTS.keepRuns }) {
  const workplanDigest = sha256(canonical(plan));
  const last = latestSnapshot(dir);
  if (last?.meta.workplanDigest === workplanDigest && last.meta.sourcesDigest === registry.digest) return last.runId;
  const seq = Number(runs(dir).at(-1)?.slice(0, 3) ?? 0) + 1;
  const runId = `${String(seq).padStart(3, '0')}-${workplanDigest.slice(0, 8)}`;
  const to = join(dir, 'history', runId);
  mkdirSync(to, { recursive: true });
  const meta = { schemaVersion: 1, kind: 'RunSnapshot', runId, caseId: registry.caseId, sourcesDigest: registry.digest, level, decisionsDigest, workplanDigest,
    inputs: registry.sources.map((s) => ({ id: s.id, role: s.role, kind: s.kind, sha256: s.sha256 })) };
  writeFileSync(join(to, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  writeFileSync(join(to, 'workplan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  for (const f of ['scope.json']) if (existsSync(join(dir, f))) cpSync(join(dir, f), join(to, f));
  if (existsSync(join(dir, 'stages', 'critic.json'))) cpSync(join(dir, 'stages', 'critic.json'), join(to, 'critic.json'));
  for (const old of runs(dir).slice(0, -keep)) rmSync(join(dir, 'history', old), { recursive: true, force: true });
  return runId;
}

// ── delta ───────────────────────────────────────────────────────────────────
function sourceIdsIn(node, out = new Set()) {
  if (Array.isArray(node)) node.forEach((x) => sourceIdsIn(x, out));
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) { if (k === 'sourceId' && typeof v === 'string') out.add(v); else sourceIdsIn(v, out); }
  return out;
}

export function buildDelta(registry, snap) {
  const before = new Map(snap.meta.inputs.map((i) => [i.id, i]));
  const now = new Map(registry.sources.map((s) => [s.id, s]));
  const row = (s) => ({ id: s.id, role: s.role });
  const added = [...now.values()].filter((s) => !before.has(s.id)).map(row);
  const removed = [...before.values()].filter((s) => !now.has(s.id)).map(row);
  const changed = [...now.values()].filter((s) => before.has(s.id) && (before.get(s.id).sha256 !== s.sha256 || before.get(s.id).role !== s.role)).map(row);
  const touched = new Set([...changed, ...removed].map((x) => x.id));
  // 영향 후보: 바뀌거나 사라진 입력을 근거(sourceId)로 든 이전 계획서의 항목. 새로 추가된 입력은 근거가 없으므로 후보를 정할 수 없다 — triage 가 판단한다.
  const candidateIds = SECTIONS.flatMap((k) => snap.plan[k] ?? []).filter((item) => [...sourceIdsIn(item)].some((id) => touched.has(id))).map((i) => i.id).sort();
  const total = new Set([...before.keys(), ...now.keys()]).size;
  return { schemaVersion: 1, kind: 'InputDelta', previous: snap.runId, added, changed, removed, unchanged: total - added.length - changed.length - removed.length,
    changedRatio: total ? Math.round(((added.length + changed.length + removed.length) / total) * 1000) / 1000 : 0, candidateIds };
}

// ── 가드레일 (LLM 을 부르기 전에 걸 수 있는 상한) ───────────────────────────────
// 걸리면 rewrite 로 강제한다. 증분은 범위가 그대로라는 전제에서만 안전하다.
export function guardrails(delta, th = DEFAULTS) {
  const out = [];
  const all = [...delta.added, ...delta.changed, ...delta.removed];
  if (all.length === 0) out.push({ rule: 'no-input-change', detail: '입력 파일은 같고 등록 정보(brief·계보)만 달라졌다 — 증분 대상이 아니다' });
  if (delta.changedRatio > th.maxChangedRatio) out.push({ rule: 'changed-ratio', detail: `바뀐 입력 비율 ${delta.changedRatio} > ${th.maxChangedRatio}` });
  if (delta.removed.length > th.maxRemoved) out.push({ rule: 'removed-count', detail: `삭제된 입력 ${delta.removed.length}건 > ${th.maxRemoved}` });
  const scope = all.filter((x) => SCOPE_ROLES.includes(x.role));
  if (scope.length) out.push({ rule: 'scope-input', detail: `범위 경계를 정하는 입력(${SCOPE_ROLES.join('·')})이 추가·교체·삭제됨 — ${scope.map((x) => x.id).join(', ')}` });
  return out;
}

// ── triage 출력 검사 ────────────────────────────────────────────────────────
export function triageViolations(out, delta, plan, { decisionsChanged = false } = {}) {
  if (!out || typeof out !== 'object') return ['stages/triage.json 이 없거나 JSON 이 아님'];
  const v = [];
  if (!ACTIONS.includes(out.action)) v.push(`action 은 ${ACTIONS.join('|')}`);
  if (typeof out.reason !== 'string' || !out.reason.trim()) v.push('reason(판정 근거)이 없음');
  if (out.action === 'skip' && decisionsChanged) v.push('결정(decisions.json)이 바뀌었는데 skip — 결정이 가리키는 항목을 반영해야 하므로 incremental 이나 rewrite 다');
  if (out.action === 'incremental') {
    const ids = new Set(itemIds(plan).keys());
    const impact = Array.isArray(out.impactIds) ? out.impactIds : [];
    if (impact.length === 0) v.push('incremental 인데 impactIds 가 비었음 — 영향 항목이 없으면 skip 이다(조용히 넘기지 않는다)');
    for (const id of impact) if (!ids.has(id)) v.push(`impactIds 에 이전 계획서에 없는 id — ${id}`);
    const kept = new Map((Array.isArray(out.kept) ? out.kept : []).map((k) => [k?.id, k?.reason]));
    for (const id of delta.candidateIds) if (!impact.includes(id) && !String(kept.get(id) ?? '').trim()) v.push(`바뀐 입력을 근거로 든 항목 ${id} 가 impactIds 에도, 이유를 단 kept 에도 없음`);
  }
  return v;
}

// ── 증분 게이트 ─────────────────────────────────────────────────────────────
// 영향 목록 밖 항목은 바이트 단위(정규형 digest)로 보존돼야 한다. 영향 항목과 새 항목은 자유롭다.
export function preservedViolations(before, after, impact) {
  const a = itemIds(before); const b = itemIds(after); const free = new Set(impact);
  const out = [];
  for (const [id, digest] of a) {
    if (free.has(id)) continue;
    if (!b.has(id)) out.push(`영향 목록 밖 항목이 사라짐 — ${id}`);
    else if (b.get(id) !== digest) out.push(`영향 목록 밖 항목이 바뀜 — ${id} (바꿔야 하면 impactIds 에 있어야 한다)`);
  }
  return out;
}

// 증분 비평의 범위: 영향 항목 + 새로 생긴 항목, 그리고 그 항목들이 속한 화면.
export function criticScope(before, after, impact) {
  const old = itemIds(before);
  const ids = new Set([...impact, ...[...itemIds(after).keys()].filter((id) => !old.has(id))]);
  const scoped = SECTIONS.flatMap((k) => after[k] ?? []).filter((i) => ids.has(i.id));
  const surfaces = new Set([...scoped.map((i) => i.surface), ...(after.surfaces ?? []).filter((x) => ids.has(x.id)).map((x) => x.id)].filter(Boolean));
  return { ids, surfaces };
}

// 지적 이월: 비평 범위 밖 항목에 대한 이전 지적은 항목이 그대로이므로 해소되지 않은 것이다 — 최초 발생 run 을 남기며 이월한다.
// 비평 범위 안의 이전 지적은 새 비평이 다시 판단하므로, 다시 지적되지 않으면 해소된 것으로 기록한다. 새 지적의 id 는 이월 id 뒤로 이어 붙인다.
export function mergeFindings(prevFindings, fresh, scope, planIds, previousRunId) {
  const carried = prevFindings.filter((f) => !scope.ids.has(f.target) && planIds.has(f.target)).map((f) => ({ ...f, carriedFrom: f.carriedFrom ?? previousRunId }));
  const used = [...carried, ...prevFindings].map((f) => Number(String(f.id).match(/(\d+)$/)?.[1] ?? 0));
  let n = Math.max(0, ...used);
  const raised = fresh.map((f) => { n += 1; return { ...f, id: `F-${String(n).padStart(3, '0')}` }; });
  const carriedIds = new Set(carried.map((f) => f.id));
  return { findings: [...carried, ...raised], report: { carried: carried.map((f) => ({ id: f.id, carriedFrom: f.carriedFrom })), resolved: prevFindings.filter((f) => !carriedIds.has(f.id)).map((f) => f.id), raised: raised.map((f) => f.id) } };
}
