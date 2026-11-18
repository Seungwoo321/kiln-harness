// 목적 프로파일 연결 — 앞 단계 사례의 계획서에서 조건(C-xx)·결정·미결을 이어받는다(엔진 공통).
// 이어받은 조건은 다시 열거하지 않는다: 이 사례의 범위는 자기 원본의 새 조건만 쓰고, 엔진이 앞 단계 조건을 앞에 붙인다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, sha256, previousDir } from '../register.mjs';
import { readDecisions } from '../decide.mjs';

export function readUpstream(caseDir, registry) {
  const link = registry.upstream;
  if (!link) return null;
  const dir = previousDir(caseDir, link.case);
  const plan = JSON.parse(readFileSync(join(dir, 'workplan.json'), 'utf8'));
  if (sha256(canonical(plan)) !== link.workplanDigest) throw new Error(`앞 단계 사례가 등록 뒤에 바뀌었다 — ${link.case} (다시 등록한다)`);
  return {
    caseId: link.caseId, kind: link.kind,
    conditions: (plan.conditions ?? []).map(({ inherited, ...c }) => ({ ...c, inherited: inherited ?? link.caseId })),
    decisions: [...(plan.decisions ?? []).map((d) => ({ id: d.id, statement: d.statement ?? d.note })), ...readDecisions(dir).map((d) => ({ id: d.id, statement: d.note }))],
    open: (plan.open ?? []).map((u) => ({ id: u.id, question: u.question, default: u.default })),
  };
}

// 범위 결과에 앞 단계 조건을 붙인다. 이 사례의 조건 id 가 앞 단계 id 와 겹치면 위반이다.
export function inheritConditions(scope, upstream) {
  if (!upstream) return { violations: [], value: scope };
  const taken = new Set(upstream.conditions.map((c) => c.id));
  const own = (scope.conditions ?? []).filter((c) => !c.inherited);
  const clash = own.filter((c) => taken.has(c.id)).map((c) => `conditions: ${c.id} 는 앞 단계 사례(${upstream.caseId})의 조건 id 다 — 이어받은 조건은 다시 쓰지 않고, 새 조건은 다른 번호를 쓴다`);
  return { violations: clash, value: { ...scope, conditions: [...upstream.conditions, ...own] } };
}

export function upstreamBrief(stage, upstream) {
  if (!upstream || !['scope', 'interpret', 'critic'].includes(stage)) return '';
  const head = `\n\n[앞 단계 사례 — ${upstream.caseId} (${upstream.kind})]`;
  if (stage === 'scope') return `${head}\n- 조건 ${upstream.conditions.map((c) => c.id).join(', ') || '(없음)'} 은 앞 단계에서 확정돼 스크립트가 이어받는다. conditions 에 다시 쓰지 않는다. 이 사례의 원본에서 나온 새 조건만 그 id 와 겹치지 않는 번호로 쓴다.`;
  const decisions = upstream.decisions.length ? `\n- 앞 단계 결정(확정값 — 다시 묻지 않는다):\n${upstream.decisions.map((d) => `  · ${d.id}: ${d.statement}`).join('\n')}` : '';
  const open = upstream.open.length ? `\n- 앞 단계의 미결(기본값으로 진행 중 — 같은 질문을 새로 만들지 않는다):\n${upstream.open.map((u) => `  · ${u.id}: ${u.question} (기본값: ${u.default})`).join('\n')}` : '';
  return `${head}\n- 이어받은 조건(stages/scope.json 의 conditions 중 inherited 가 있는 것)도 이 사례의 항목으로 모두 처리한다.${decisions}${open}`;
}
