import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, sha256 } from '../register.mjs';

export function readDesignSpecs(dir, registry) {
  const statusFile = join(dir, 'design-spec-status.json');
  if (existsSync(statusFile)) {
    const status = JSON.parse(readFileSync(statusFile, 'utf8'));
    if (status.status === 'skipped') return [];
    if (status.status === 'failed') throw new Error(`design-spec 실패: ${status.reason}`);
  }
  return registry.sources.filter(s => s.kind === 'design-html' && s.role === 'design').flatMap(s => {
    if (!/^[\w.-]+$/.test(s.id) || ['.', '..'].includes(s.id)) throw new Error('잘못된 design sourceId');
    const file = join(dir, 'design-spec', `${s.id}.json`);
    if (!existsSync(file)) return [];
    const spec = JSON.parse(readFileSync(file, 'utf8'));
    const { digest, ...body } = spec;
    if (spec.kind !== 'DesignSpec' || spec.schemaVersion !== 1 || spec.sourceId !== s.id || spec.inputDigest !== s.sha256 || sha256(canonical(body)) !== digest) throw new Error(`design-spec 증거가 현재 입력과 다르거나 손상됨: ${s.id}`);
    return [spec];
  });
}

export function behaviorConflicts(plan, specs) {
  const result = [];
  for (const row of plan.designSpecs ?? []) {
    const spec = specs.find(s => s.sourceId === row.sourceId);
    const interaction = spec?.interactions.find(i => i.id === row.element);
    if (!interaction) continue;
    const requirement = (plan.requirements ?? []).find(r => r.id === row.requirement);
    if (!requirement) continue;
    const declared = row.interaction?.openPolicy ?? requirement.interaction?.openPolicy;
    if (declared && declared !== interaction.openPolicy && interaction.openPolicy !== 'unknown') result.push({ row, spec, interaction, requirement, expected: interaction.openPolicy, actual: declared });
  }
  return result;
}

export function unresolvedBehaviorQuestion(plan, conflict) {
  return (plan.questions ?? []).find(q => q.to === 'design' && q.kind === 'confirm' && q.designEvidence?.sourceId === conflict.spec.sourceId && q.designEvidence?.interaction === conflict.interaction.id && (q.impact ?? []).includes(conflict.requirement.id) && conflict.row.question === q.id && conflict.requirement.resolution === 'pending');
}

export function validateDesignPolicy(plan, registry, specs, resolver, baseline = { samples: [] }) {
  if (plan.schemaVersion < 3 || specs.length === 0) return [];
  const errors = []; const err = (where, message) => errors.push(`${where}: ${message}`);
  if (canonical(plan.designSpecDigests ?? []) !== canonical(specs.map(s => s.digest))) err('designSpecDigests', '현재 렌더 증거 digest와 다름. 시안 규격을 다시 해석한다');
  const sources = new Map(registry.sources.map(s => [s.id, s]));
  const rows = Array.isArray(plan.designSpecs) ? plan.designSpecs : [];
  if (!Array.isArray(plan.designSpecs)) err('designSpecs', '시안 규격 배열이 필요함');
  const evidence = (where, refs, role) => {
    if (!Array.isArray(refs) || !refs.length) { err(where, `${role} 근거 경로가 필요함`); return; }
    for (const r of refs) if (sources.get(r.sourceId)?.role !== role || !resolver.resolve(r.sourceId, r.locator).ok) err(where, `${role}의 실재 코드/원본 근거가 아님: ${r.sourceId}:${r.locator}`);
  };
  for (const r of plan.requirements ?? []) {
    if (!(r.sourceRefs ?? []).some(ref => sources.get(ref.sourceId)?.role === 'plan')) continue;
    const w = `requirements:${r.id}`; const p = r.sourcePolicy;
    if (r.basis === 'inferred' && (plan.decisions ?? []).some(d => d.id === r.decision)) continue;
    if (!['policy', 'ui'].includes(r.category)) err(w, 'plan 근거 요구사항에 category:policy|ui가 필요함');
    if (!p?.reason) err(w, '출처별 수용 분류와 이유(sourcePolicy)가 필요함');
    if (p?.classification === 'adopt' && r.category === 'policy') evidence(w, p.evidence, 'plan');
    else if (p?.classification === 'existing-pattern') evidence(w, p.evidence, 'implementation');
    else err(w, 'plan UI 요구사항은 existing-pattern 코드 근거 또는 adopt 정책 근거가 필요함. 임의 프로토타입 동작은 확정할 수 없음');
  }
  for (const o of plan.planObservations ?? []) {
    if (!['adopt', 'existing-pattern', 'omission-suspect', 'prototype-artifact'].includes(o.classification) || !o.reason) err('planObservations', '분류와 이유가 필요함');
    evidence('planObservations', o.sourceRefs, 'plan');
    if (o.classification === 'existing-pattern' || o.classification === 'omission-suspect') evidence('planObservations', o.evidence, 'implementation');
    if (o.classification === 'omission-suspect' && !(plan.questions ?? []).some(q => q.id === o.question && q.to === 'plan')) err('planObservations', '누락 의심은 to:plan 질문이 필요함');
  }
  for (const [i, row] of rows.entries()) {
    const w = `designSpecs[${i}]`; const spec = specs.find(s => s.sourceId === row.sourceId);
    const element = spec?.elements.find(e => e.id === row.element); const interaction = spec?.interactions.find(e => e.id === row.element);
    if (!element && !interaction) { err(w, '실재하는 design-spec 증거 id가 필요함'); continue; }
    if (!['strict', 'component-rule', 'htmlLimit'].includes(row.verdict) || !row.reason) err(w, 'strict|component-rule|htmlLimit 판정과 이유가 필요함');
    if (['htmlLimit', 'component-rule'].includes(row.verdict) && !baseline.samples.some(b => b.id === row.baseline)) err(w, '컴포넌트 판정에 실재하는 baseline id가 필요함');
    if (row.componentHint && (!Array.isArray(row.componentHint.classes) || !row.componentHint.classes.length || row.componentHint.classes.some(c => !element?.classes.includes(c)))) err(w, 'componentHint에는 시안에 실재하는 근거 클래스가 필요함');
    if (row.component && !(plan.components ?? []).some(c => c.id === row.component)) err(w, '없는 component id');
    if (row.requirement && !(plan.requirements ?? []).some(r => r.id === row.requirement)) err(w, '없는 requirement id');
    if (interaction && !row.requirement) err(w, '상호작용은 requirement에 연결해야 함');
    if (interaction && !['single', 'multi', 'unknown'].includes(row.interaction?.openPolicy)) err(w, '상호작용에는 구조화된 interaction.openPolicy가 필요함');
  }
  const inScope = new Set((plan.surfaces ?? []).flatMap(s => (s.sourceRefs ?? []).map(r => r.sourceId)));
  for (const spec of specs.filter(s => inScope.has(s.sourceId))) {
    if (!rows.some(r => r.sourceId === spec.sourceId)) err('designSpecs', `${spec.sourceId}의 시안 규격이 없음`);
    for (const interaction of spec.interactions) if (!rows.some(r => r.sourceId === spec.sourceId && r.element === interaction.id)) err('designSpecs', `${spec.sourceId}:${interaction.id} 상호작용 규칙이 요구사항에 연결되지 않음`);
  }
  for (const c of behaviorConflicts(plan, specs)) if (!unresolvedBehaviorQuestion(plan, c)) err(`requirements:${c.requirement.id}`, `design-spec ${c.spec.sourceId}:${c.interaction.id} 동작 충돌: 시안 ${c.expected}, 요구사항 ${c.actual}. 다음 시도에서 해소하거나 to:design 질문과 resolution:pending으로 올린다`);
  return errors;
}
