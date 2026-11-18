// design-review — 요구 원본과 설계 문서 집합을 입력으로, 요구 조건이 설계에 빠짐없이 반영됐는지와 지정 불변식이 반례 시나리오에서도
// 지켜지는지를 검증하고 보완안을 내는 목적 프로파일. 분류 단위는 요구 조건(엔진의 조건 커버리지 C-xx)과 검증할 불변식이다.
// 문서 집합 내부 정합성(수치·용어·링크 일치) 검사는 이 프로파일의 범위가 아니다.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from './validate.mjs';
import { render } from './render.mjs';
import { scopeGate, interpretGate, prune } from './gates.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export default {
  id: 'design-review',
  kind: 'DesignReview',
  schemaVersion: 1,
  unit: { section: 'invariants', ref: 'invariant', label: '불변식' },
  sections: ['invariants', 'coverage', 'traces', 'remedies'],
  inferable: [],
  conditionRoles: ['plan'],
  derived: ['review.html'],
  roleWarnings: {
    plan: '요구 원본이 없다 — 검증 기준이 없으므로 시작할 수 없다',
    subject: '검토 대상 설계 문서가 없다 — 검토할 것이 없다',
    context: '확정 결정·배경 문서가 없다',
    implementation: '구현 코드가 없다 — 설계를 코드로 확인하지 않는다(선택)',
  },
  expectedRoles: ['subject'],
  role: (name) => readFileSync(join(HERE, 'roles', `${name}.md`), 'utf8'),
  gates: { scope: (...a) => scopeGate(...a), interpret: (...a) => interpretGate(...a), critic: () => [] },
  criticFields: () => ({}),
  protectedQuestions: () => new Map(),
  prune: (...a) => prune(...a),
  validate: (...a) => validate(...a),
  render: (dir) => { render(dir); },
  prepare: () => ({ ok: true }),
  upToDate: () => true,
  statusExtras: () => ({}),
  catalogExtras: () => ({}),
  levelBlock: (stage, n) => (stage !== 'scope' && n >= 7 ? `\n\n[검토 수준 ${n}/10 — 체계 검증]\n- 모든 판정은 문서 위치로 뒷받침한다. 의심스러우면 covered 대신 mention-only, holds 대신 undocumented 로 둔다.` : ''),
  prompt: {
    interpretInputs: `범위: stages/scope.json. 결과 형식: ${join(HERE, 'FORMAT.md')}.`,
    extras: () => '',
    incrementalCritic: () => '',
    stages: {},
  },
  cli: { validate: join(HERE, 'validate.mjs'), render: join(HERE, 'render.mjs'), 'render-review': join(HERE, 'render.mjs') },
  commands: {},
};
