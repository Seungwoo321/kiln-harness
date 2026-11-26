// fe-workplan — 기획·디자인·코드·계약을 화면 구현 작업계획(WorkPlan)으로 바꾸는 목적 프로파일.
// 엔진은 이 계약만 호출한다. 분류 단위는 화면(surfaces)이고, 산출물은 작업계획(workplan.json·WORKPLAN.md·review.html)이다.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from './validate.mjs';
import { render } from './render.mjs';
import { renderReview } from './render-review.mjs';
import { readDesignSpecs } from './lib/design-policy.mjs';
import { seal } from './design-spec.mjs';
import { scopeGate, interpretGate, criticGate, criticFields, protectedQuestions, prune } from './gates.mjs';
import { levelBlock } from './levels.mjs';
import { runConformance, conformanceGate } from './conformance-stage.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const tryJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

const ROLE_WARNINGS = {
  plan: '기획 원본이 없다 — 요구사항의 출처가 없으므로 작업을 시작할 수 없다',
  design: '디자인 시안이 없다 — 화면 구성·상태는 기획과 현재 코드에서만 근거를 찾는다. 시안에서 온 것처럼 쓰지 않는다',
  contract: 'API 계약이 등록돼 있지 않다 — API·필드에 대한 사실은 단정하지 않는다. "계약에 없다"는 주장은 근거가 될 수 없다',
  implementation: '구현 코드가 등록돼 있지 않다 — 기존 파일·컴포넌트·패턴을 근거로 삼을 수 없다',
  'design-system': '디자인 시스템 코드가 등록돼 있지 않다 — ds.match 는 부품의 실제 props·동작을 확인하지 않은 추정이 된다. 시안 유무와 무관하게 등록한다',
  context: '확정 결정·배경 문서가 없다',
};

function catalogExtras(caseDir, registry) {
  const catalog = {};
  const statusFile = join(caseDir, 'design-spec-status.json');
  // 요약은 프롬프트에 그대로 실린다. 요소별 컴포넌트 후보는 시안 하나에 수 MB 라 개수만 두고, 상세는 design-spec/<sourceId>.json 에서 읽는다.
  if (existsSync(statusFile)) catalog.designSpec = { ...JSON.parse(readFileSync(statusFile, 'utf8')), summary: readDesignSpecs(caseDir, registry).map(s => ({ sourceId: s.sourceId, theme: s.render.theme, interactions: s.interactions.map(i => ({ id: i.id, kind: i.kind, items: i.items.map(x => x.label), openPolicy: i.openPolicy, initial: i.initial, reclick: i.reclick })), candidateElements: s.elements.filter(e => e.componentCandidates?.length).length })) };
  const patternFile = join(caseDir, 'existing-patterns.json');
  if (existsSync(patternFile)) catalog.existingPatterns = JSON.parse(readFileSync(patternFile, 'utf8')).candidates.length;
  return catalog;
}

// S2d — 시안 HTML 의 렌더 증거를 별도 프로세스로 수집한다. 실패하면 상태 파일에 남기고 파이프라인을 멈춘다.
function prepare(dir, { env, log }) {
  try {
    execFileSync(process.execPath, [join(HERE, 'design-spec.mjs'), dir], { env: { ...process.env, ...env }, timeout: 600000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const violation = `S2d 렌더 실패: ${e.stderr?.toString() || e.message}`;
    writeFileSync(join(dir, 'design-spec-status.json'), `${JSON.stringify(seal({ schemaVersion: 1, kind: 'DesignSpecStatus', status: 'failed', reason: violation, sources: [] }), null, 2)}\n`);
    return { ok: false, stage: 'design-spec', violation };
  }
  const status = JSON.parse(readFileSync(join(dir, 'design-spec-status.json'), 'utf8'));
  log('S2d', `design-spec: ${status.status}${status.reason ? ` (${status.reason})` : ''}`);
  return { ok: true };
}

// 렌더 증거는 본문을 싣지 않고 파일 위치만 준다 — 다른 원본처럼 에이전트가 읽는다(본문을 실으면 큰 시안에서 프롬프트가 수 MB 가 된다).
function promptExtras(stage, ctx) {
  const design = ctx.catalog?.designSpec;
  const specFiles = (design?.summary ?? []).map((s) => `design-spec/${s.sourceId}.json`);
  return design ? `\n\n[렌더 증거]\ndesign-spec: ${design.status}${design.reason ? ` (${design.reason})` : ''}. ${JSON.stringify(design.sources ?? [])}\n렌더 결과 파일(요소·계산 스타일·상호작용·요소별 컴포넌트 후보): ${specFiles.length ? specFiles.join(', ') : 'design-spec/<sourceId>.json'}. 컴포넌트 기준: component-baseline.json. 기존 UI 사용례: existing-patterns.json (${ctx.catalog.existingPatterns ?? 0}개, 적합성은 코드로 확인). 출처별 수용 정책과 v3 시안 규격을 적용한다.` : '';
}

export default {
  id: 'fe-workplan',
  kind: 'WorkPlan',
  schemaVersion: 4,
  unit: { section: 'surfaces', ref: 'surface', label: '화면' },
  sections: ['surfaces', 'requirements', 'states', 'components', 'apiBindings', 'i18n', 'gaps', 'tasks'],
  inferable: ['requirements', 'states'],
  conditionRoles: ['plan'], // 조건 커버리지 계약: 문장을 모두 분류해야 하는 원본 역할
  derived: ['WORKPLAN.md', 'WORKPLAN.html', 'review.html', 'conformance.json', 'conformance-brief.md'],
  roleWarnings: ROLE_WARNINGS,
  expectedRoles: ['design', 'contract', 'implementation', 'design-system'], // 없으면 intake 가 알리는 역할
  role: (name) => readFileSync(join(HERE, 'roles', `${name}.md`), 'utf8'),
  gates: { scope: (...a) => scopeGate(...a), interpret: (...a) => interpretGate(...a), critic: (...a) => criticGate(...a) },
  criticFields: (...a) => criticFields(...a),
  protectedQuestions: (...a) => protectedQuestions(...a),
  prune: (...a) => prune(...a),
  validate: (...a) => validate(...a),
  render: (dir) => { render(dir); renderReview(dir); },
  prepare,
  // v3 이전 계획서는 렌더 증거가 생기면 다시 해석해야 한다.
  upToDate: (dir, registry, plan) => !(plan.schemaVersion < 3 && readDesignSpecs(dir, registry).length),
  statusExtras: (dir) => ({ 'design-spec': tryJson(join(dir, 'design-spec-status.json')) }),
  catalogExtras,
  levelBlock: (...a) => levelBlock(...a),
  prompt: {
    interpretInputs: `범위: stages/scope.json. 계획서 형식: ${join(HERE, '..', '..', 'docs', 'workplan-format.md')} (v2·v3 절 포함).`,
    extras: promptExtras,
    incrementalCritic: (scope) => (scope.units.size ? ` 화면 대조(coverage)는 ${[...scope.units].join(', ')} 만 쓴다.` : ''),
    stages: {
      conformance: (ctx, feedbackBlock) => `conformance-facts.json의 사실만 근거로 구현 적합성을 판단한다. 모든 fact id를 정확히 한 번 판정한다. 결과는 stages/conformance.json이다. 형식은 역할 파일을 따른다. 컴포넌트 대응·수용 여부를 직접 판단하고 수집 스크립트의 후보나 오차를 정답으로 취급하지 않는다.${feedbackBlock('이전 시도의 형식 위반', ctx.feedback)}`,
    },
  },
  cli: Object.fromEntries(['validate', 'render', 'render-review', 'design-spec', 'verify', 'export-goal'].map((n) => [n, join(HERE, `${n}.mjs`)])),
  commands: { conformance: (...a) => runConformance(...a), conformanceGate: (...a) => conformanceGate(...a) },
};
