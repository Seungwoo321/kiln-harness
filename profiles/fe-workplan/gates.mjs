// fe-workplan 게이트 — 범위(화면 분류)·해석(작업계획 초안)·비평(화면별 원본 대조)의 결정적 검사.
// 엔진은 단계 루프에서 이 함수들을 호출하고, 위반 목록을 다음 시도에 주입한다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate } from './validate.mjs';
import { readDesignSpecs } from './lib/design-policy.mjs';
import { DEFAULT_LEVEL } from '../../scripts/lib/levels.mjs';

const tryJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

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

// 해석 초안: 범위의 화면을 그대로 다뤄야 하고, 렌더 관찰값을 시안 행에 붙인 뒤 계획서 형식 전체를 검증한다.
export function interpretGate({ dir, registry, scope, draft, plan }) {
  const out = [];
  const want = new Set(scope.surfaces.map((s) => s.id));
  const got = new Set((draft.surfaces ?? []).map((s) => s.id));
  for (const id of want) if (!got.has(id)) out.push(`범위의 화면이 계획서에 없음 — ${id}`);
  for (const id of got) if (!want.has(id)) out.push(`범위에 없는 화면을 추가함 — ${id}`);
  const specs = readDesignSpecs(dir, registry);
  plan.designSpecDigests = specs.map(s => s.digest);
  for (const row of plan.designSpecs ?? []) {
    const spec = specs.find(s => s.sourceId === row.sourceId);
    row.observation = spec?.elements.find(e => e.id === row.element) ?? spec?.interactions.find(i => i.id === row.element) ?? null;
  }
  out.push(...validate(dir, plan));
  return { violations: out, value: plan };
}

// 시안 동작 충돌 질문은 비평이 내리거나 지울 수 없다.
export const protectedQuestions = (plan) => new Map((plan.questions ?? []).filter((q) => q.designEvidence).map((q) => [q.id, '시안 동작 충돌 질문은 내리거나 제거할 수 없음']));

// 질문이 사라지면 작업의 covers 에서도 뺀다.
export function prune(plan, gone) {
  for (const task of plan.tasks ?? []) task.covers = (task.covers ?? []).filter((id) => !gone.has(id));
}

// 체계 검증(수준 8 이상): 화면마다 어떤 원본끼리 대조했는지 남아야 한다 — 대조 없이 통과시키지 않는다.
export function criticGate({ plan, crit, registry, inc }) {
  const out = [];
  if ((plan.level ?? DEFAULT_LEVEL) < 8) return out;
  const cov = Array.isArray(crit.coverage) ? crit.coverage : [];
  const need = registry.sources.filter((x) => ['plan', 'design', 'contract'].includes(x.role)).map((x) => x.id);
  for (const sf of (plan.surfaces ?? []).filter((x) => !inc || inc.scope.units.has(x.id))) {
    const c = cov.find((x) => x.surface === sf.id);
    if (!c) { out.push(`coverage: 화면 ${sf.id} 의 대조 기록이 없음`); continue; }
    const got = new Set(Array.isArray(c.sourcesCompared) ? c.sourcesCompared : []);
    for (const id of need) if (!got.has(id)) out.push(`coverage: 화면 ${sf.id} 에서 ${id} 와 대조하지 않음`);
    if (!c.result) out.push(`coverage: 화면 ${sf.id} 의 result 가 없음`);
  }
  return out;
}

// 비평 결과에서 계획서로 옮길 프로파일 필드. 증분이면 범위 밖 화면의 이전 대조 기록을 잇는다.
export function criticFields({ plan, crit, inc }) {
  if ((plan.level ?? DEFAULT_LEVEL) < 8) return {};
  if (!inc) return { coverage: crit.coverage };
  const planSurfaces = new Set((plan.surfaces ?? []).map((x) => x.id));
  return { coverage: [...(inc.prev.plan?.coverage ?? []).filter((c) => !inc.scope.units.has(c.surface) && planSurfaces.has(c.surface)), ...(crit.coverage ?? [])] };
}
