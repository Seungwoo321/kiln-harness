// requirements — 기획·과제·회의 기록에서 요구사항을 정의하는 목적 프로파일. 원본의 상황·배경 문장을 모두 조건으로 분류하고
// (엔진의 조건 커버리지 계약), 요구사항·검증 가능한 수용기준·미결(기본값)·범위 밖·변경 내역을 낸다.
// 산출물은 다음 목적 사례(design-review·fe-workplan)의 upstream 이 되어 조건·결정·미결을 넘긴다.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from './validate.mjs';
import { render } from './render.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const tryJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

function scopeGate(dir) {
  const scope = tryJson(join(dir, 'stages', 'scope.json'));
  if (!scope) return { violations: ['stages/scope.json 이 없거나 JSON 이 아님'] };
  const out = [];
  (scope.excluded ?? []).forEach((x, i) => { if (!x?.title || !x?.reason) out.push(`excluded[${i}]: title·reason 이 필요함`); });
  return { violations: out, value: scope };
}

export default {
  id: 'requirements',
  kind: 'Requirements',
  schemaVersion: 1,
  unit: { section: 'requirements', ref: 'requirement', label: '요구사항' },
  sections: ['requirements', 'open', 'changes'],
  inferable: [],
  conditionRoles: ['plan', 'context'],
  derived: ['review.html'],
  roleWarnings: { plan: '기획·과제 원본이 없다 — 요구사항의 출처가 없으므로 시작할 수 없다', context: '회의 기록·확정 결정·배경 문서가 없다' },
  expectedRoles: [],
  role: (name) => readFileSync(join(HERE, 'roles', `${name}.md`), 'utf8'),
  gates: { scope: (dir) => scopeGate(dir), interpret: ({ dir, plan }) => ({ violations: validate(dir, plan), value: plan }), critic: () => [] },
  criticFields: () => ({}),
  protectedQuestions: () => new Map(),
  prune: (plan, gone) => { for (const u of plan.open ?? []) u.impact = (u.impact ?? []).filter((id) => !gone.has(id)); },
  validate: (...a) => validate(...a),
  render: (dir) => { render(dir); },
  prepare: () => ({ ok: true }),
  upToDate: () => true,
  statusExtras: () => ({}),
  catalogExtras: () => ({}),
  levelBlock: (stage, n) => (stage === 'interpret' && n >= 7 ? `\n\n[검토 수준 ${n}/10 — 체계 검증]\n- 요구사항마다 수용기준을 2개 이상 쓰고, 미결은 원본으로 정할 수 없는 것만 남긴다.` : ''),
  prompt: {
    interpretInputs: `범위: stages/scope.json. 결과 형식: ${join(HERE, 'FORMAT.md')}.`,
    extras: () => '',
    incrementalCritic: () => '',
    stages: {},
  },
  cli: { validate: join(HERE, 'validate.mjs'), render: join(HERE, 'render.mjs'), 'render-review': join(HERE, 'render.mjs') },
  commands: {},
};
