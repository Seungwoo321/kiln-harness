// design-review 게이트 — 범위(조건 분류·검증할 불변식)와 해석(커버리지·반례 추적·보완안)의 결정적 검사.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate } from './validate.mjs';

const tryJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

export function scopeGate(dir, registry) {
  const scope = tryJson(join(dir, 'stages', 'scope.json'));
  if (!scope) return { violations: ['stages/scope.json 이 없거나 JSON 이 아님'] };
  const out = [];
  const ids = new Set(registry.sources.map((s) => s.id));
  if (!Array.isArray(scope.invariants)) out.push('invariants 가 없음 — 검증할 불변식을 원본·작업 주제에서 찾아 적는다(없으면 빈 배열)');
  const seen = new Set();
  (scope.invariants ?? []).forEach((x, i) => {
    const w = `invariants[${i}]`;
    if (!/^I-\d+$/.test(x?.id ?? '') || seen.has(x.id)) out.push(`${w}: id 는 I-<번호> 이고 유일해야 함`);
    seen.add(x?.id);
    if (!String(x?.statement ?? '').trim()) out.push(`${w}: statement 가 없음`);
    if (!x?.fromBrief && !(x?.sourceRefs ?? []).some((r) => ids.has(r?.sourceId))) out.push(`${w}: 원본 위치(sourceRefs) 또는 fromBrief:true 가 필요함`);
  });
  if (!registry.sources.some((s) => s.role === 'subject')) out.push('검토 대상 설계 문서(subject 역할)가 등록돼 있지 않음');
  (scope.excluded ?? []).forEach((x, i) => { if (!x?.title || !x?.reason) out.push(`excluded[${i}]: title·reason 이 필요함`); });
  return { violations: out, value: scope };
}

// 해석 결과는 범위의 불변식을 그대로 다뤄야 한다.
export function interpretGate({ dir, scope, draft, plan }) {
  const out = [];
  const want = (scope.invariants ?? []).map((x) => x.id).sort().join();
  const got = (draft.invariants ?? []).map((x) => x.id).sort().join();
  if (want !== got) out.push(`invariants 는 범위와 같아야 함 — 범위 ${want || '(없음)'} / 계획서 ${got || '(없음)'}`);
  out.push(...validate(dir, plan));
  return { violations: out, value: plan };
}

// 질문·지적이 사라지면 보완안의 addresses 에서도 뺀다.
export function prune(plan, gone) {
  for (const x of plan.remedies ?? []) x.addresses = (x.addresses ?? []).filter((id) => !gone.has(id));
}
