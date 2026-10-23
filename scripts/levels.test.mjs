import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validate } from './validate.mjs';
import { register } from './register.mjs';
import { extract } from './extract.mjs';
import { applyQuestionVerdicts } from './lib/pipeline.mjs';
import { levelBlock, parseLevel, tierOf } from './lib/levels.mjs';

const PLAN = '<html><body>\n<h1 id="a">내보내기 설정</h1>\n<p>형식 4종: CSV PDF XLSX JSON</p>\n<p>JSON 옵션: 들여쓰기, 인코딩</p>\n</body></html>\n';
const CONTRACT = '# 계약\n\n## ExportFormat\n\nCSV, PDF, XLSX, JSON.\n\n## option_schema\n\n서버가 내려준다.\n';
const ref = [{ sourceId: 'plan1', locator: 'L3-4' }];
const specRef = { sourceId: 'spec', locator: 'option_schema' };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'kh-lv-'));
  writeFileSync(join(dir, 'plan.html'), PLAN); writeFileSync(join(dir, 'contract.md'), CONTRACT);
  writeFileSync(join(dir, 'inputs.json'), JSON.stringify({ caseId: 'fx', inputs: [
    { id: 'plan1', kind: 'plan-html', role: 'plan', path: join(dir, 'plan.html') },
    { id: 'spec', kind: 'context-doc', role: 'context', path: join(dir, 'contract.md') },
  ] }));
  register(dir); extract(dir);
  return dir;
}
const base = (over = {}) => ({
  title: 'T', summary: 'S', newFiles: [],
  surfaces: [{ id: 'S1', title: '화면', entry: '/x', change: 'new', sourceRefs: ref }], excluded: [{ title: '계약', reason: '입력', sourceRefs: [specRef] }],
  requirements: [{ id: 'R1', surface: 'S1', statement: '형식 4종', acceptance: ['a'], basis: 'source', sourceRefs: ref }],
  states: [{ id: 'ST1', surface: 'S1', region: 'r', state: 's', condition: 'c', display: 'd', basis: 'source', sourceRefs: ref }],
  components: [{ id: 'C1', surface: 'S1', name: 'A', file: 'src/a.tsx', fileStatus: 'new', ds: { component: null, match: 'custom', reason: '없다' }, sourceRefs: ref }],
  apiBindings: [], i18n: [], gaps: [{ id: 'G1', surface: 'S1', current: 'c', target: 't' }], questions: [], decisions: [],
  tasks: [{ id: 'T1', title: '작업', files: ['src/a.tsx'], dependsOn: [], covers: ['S1', 'C1', 'R1', 'ST1', 'G1'], changeKind: 'new-page' }],
  ...over,
});
const errs = (level, over, mutate) => {
  const dir = fixture();
  const plan = { schemaVersion: 2, kind: 'WorkPlan', caseId: 'fx', inputDigests: JSON.parse(readFileSync(join(dir, 'sources.json'), 'utf8')).sources.map((s) => s.sha256), level, ...base(over), findings: [] };
  mutate?.(plan);
  return validate(dir, plan);
};
const fitted = (over = {}) => ({ id: 'D-F1', kind: 'fitted', statement: 'JSON 옵션은 indent·encoding', rationale: '기획 L3-4 의 옵션 문구에 맞췄다', sourceRefs: ref, alternatives: [{ option: '옵션 없음', whyNot: '기획이 옵션을 말한다' }], ...over });
const blocking = (over = {}) => ({ id: 'Q1', kind: 'confirm', claimType: 'wrong', evidence: '두 원본이 서로 배타적', to: 'backend', question: '저장 방식이 둘 다 성립하지 않는다', options: [], assumption: '-', impact: ['R1'], sourceRefs: ref, blocking: true, blockedReason: '어느 쪽으로도 계약을 만족시킬 수 없다', triedFits: [{ option: 'A', whyNot: '계약 위반' }, { option: 'B', whyNot: '기획 위반' }], ...over });

test('수준 파싱: 0~10 정수만, 구간은 fit(0-3) standard(4-6) strict(7-10)', () => {
  assert.equal(parseLevel('0'), 0); assert.equal(parseLevel(10), 10);
  for (const bad of ['11', -1, 2.5, 'x', '']) assert.throws(() => parseLevel(bad));
  assert.deepEqual([0, 3, 4, 6, 7, 10].map(tierOf), ['fit', 'fit', 'standard', 'standard', 'strict', 'strict']);
});

test('프롬프트: 5 는 지시가 없고, 느슨은 fitted·blocking, 엄격은 coverage 를 요구한다', () => {
  assert.equal(levelBlock('interpret', 5), ''); assert.equal(levelBlock('scope', 0), '');
  assert.ok(levelBlock('interpret', 2).includes('fitted') && levelBlock('interpret', 2).includes('blocking:true'));
  assert.ok(levelBlock('interpret', 0).includes('3개') && levelBlock('interpret', 3).includes('2개'));
  assert.ok(levelBlock('critic', 2).includes('demote'));
  assert.ok(levelBlock('critic', 8).includes('coverage') && !levelBlock('critic', 7).includes('coverage'));
  assert.ok(levelBlock('interpret', 9).includes('2개 이상') && !levelBlock('interpret', 8).includes('acceptance'));
});

test('표준(5): 기존 규칙 그대로 — fitted 는 쓸 수 없다', () => {
  assert.deepEqual(errs(5), []);
  assert.ok(errs(5, { decisions: [fitted()] }).some((e) => e.includes('level:fit')));
  assert.deepEqual(errs(undefined), []); // level 이 없는 옛 계획서는 5
});

test('느슨(fit): fitted 결정은 alternatives 가 필요하고, 그 결정에 기대는 항목은 basis:fitted', () => {
  const ok = { decisions: [fitted()], requirements: [{ id: 'R1', surface: 'S1', statement: 'x', acceptance: ['a'], basis: 'fitted', decision: 'D-F1', sourceRefs: ref }] };
  assert.deepEqual(errs(2, ok), []);
  assert.ok(errs(2, { decisions: [fitted({ alternatives: [] })] }).some((e) => e.includes('alternatives')));
  assert.ok(errs(2, { ...ok, requirements: [{ ...ok.requirements[0], decision: 'D-없음' }] }).some((e) => e.includes('fitted 결정이 아님')));
});

test('느슨(fit): 질문은 blocking·blockedReason·triedFits 를 갖춘 것만 — 0 은 3개 이상', () => {
  assert.deepEqual(errs(2, { questions: [blocking()] }), []);
  assert.ok(errs(2, { questions: [blocking({ blocking: false })] }).some((e) => e.includes('blocking:true')));
  assert.ok(errs(2, { questions: [blocking({ blockedReason: '' })] }).some((e) => e.includes('blockedReason')));
  assert.ok(errs(2, { questions: [blocking({ triedFits: [{ option: 'A', whyNot: 'x' }] })] }).some((e) => e.includes('triedFits')));
  assert.ok(errs(0, { questions: [blocking()] }).some((e) => e.includes('3개 이상')));
  assert.deepEqual(errs(0, { questions: [blocking({ triedFits: [1, 2, 3].map((n) => ({ option: `o${n}`, whyNot: 'x' })) })] }), []);
  assert.ok(errs(5, { questions: [blocking({ blocking: undefined, triedFits: undefined, blockedReason: undefined })] }).every((e) => !e.includes('blocking')));
});

test('엄격(strict): 7 부터 요구·상태가 task 에 연결돼야 하고 9 부터 수용기준 2개', () => {
  const loose = { tasks: [{ id: 'T1', title: '작업', files: ['src/a.tsx'], dependsOn: [], covers: ['S1', 'C1', 'G1'], changeKind: 'new-page' }] };
  assert.deepEqual(errs(6, loose), []);
  const e7 = errs(7, loose);
  assert.ok(e7.some((e) => e.includes('requirements:R1')) && e7.some((e) => e.includes('states:ST1')));
  assert.deepEqual(errs(8), []);
  assert.ok(errs(9).some((e) => e.includes('acceptance')));
  assert.deepEqual(errs(9, { requirements: [{ id: 'R1', surface: 'S1', statement: 'x', acceptance: ['a', 'b'], basis: 'source', sourceRefs: ref }] }), []);
  assert.ok(errs(5, undefined, (p) => { p.level = 12; }).some((e) => e.includes('0~10')));
});

test('비평이 fitted 로 내린 질문은 추론 항목을 basis:fitted 로 바꾼다', () => {
  const plan = base({ questions: [{ id: 'Q1', kind: 'notice' }], requirements: [{ id: 'R2', surface: 'S1', statement: 'x', acceptance: ['a'], basis: 'inferred', question: 'Q1', sourceRefs: [] }], tasks: [], findings: [] });
  const out = applyQuestionVerdicts(plan, new Map([['Q1', { kind: 'fitted', statement: 's', rationale: 'r', sourceRefs: ref, alternatives: [] }]]), new Set());
  assert.equal(out.requirements[0].basis, 'fitted'); assert.equal(out.requirements[0].decision, 'D-Q1');
  const std = applyQuestionVerdicts(plan, new Map([['Q1', { kind: 'single-source', statement: 's', rationale: 'r', sourceRefs: ref }]]), new Set());
  assert.equal(std.requirements[0].basis, 'source');
});
