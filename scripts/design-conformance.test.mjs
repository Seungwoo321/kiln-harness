import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { register } from './register.mjs';
import { extract } from './extract.mjs';
import { designSpec, readJson, seal, componentCandidates } from './design-spec.mjs';
import { findChrome, serve, navigate } from './lib/browser.mjs';
import { verify, parseArgs } from './verify.mjs';
import { inspectCode, compareFacts, judgmentErrors, groundJudgments } from './lib/conformance.mjs';
import { validate } from './validate.mjs';
import { validateDesignPolicy, readDesignSpecs } from './lib/design-policy.mjs';
import { interpretGate, conformanceGate, runConformance } from './lib/pipeline.mjs';

const CSS = `:root{--chip-w-a:64px;--chip-bg-a:#126839}body{margin:0;font:14px sans-serif}main{width:700px;margin:0 auto}.row{height:63px;width:100%;padding:12px;display:flex;align-items:center;gap:21px;box-sizing:border-box}.h-7{height:28px}.rounded-md{border-radius:6px}[class~="w-(--chip-w-a)"]{width:var(--chip-w-a)}[class~="bg-(--chip-bg-a)"]{background-color:var(--chip-bg-a)}.chip{display:inline-flex;align-items:center;justify-content:center}.button-md{height:40px;padding:0 16px;border-radius:6px}.emphasis{font-weight:700}p{margin:0}button{color:inherit}`;
const BADGE = '<span data-component="chip" class="chip h-7 rounded-md w-(--chip-w-a) bg-(--chip-bg-a)">Active</span>';
const BUTTON = '<button type="button" data-component="button" data-size="md" class="button-md">Test</button>';
const page = (multi = false, implementation = false) => `<!doctype html><html><head><link rel="stylesheet" href="./styles.css"></head><body class="dark"><main data-conformance-root><section aria-label="Channels"><button type="button" class="row" aria-expanded="false" aria-controls="a" data-acc-trigger>First ${BADGE}</button><div id="a" hidden><p class="emphasis">Important</p><input placeholder="Address" type="text"><a href="#">Help</a>${implementation ? BUTTON : BUTTON.replace('class="button-md"', 'class="button-md" style="height:41px"')}<button type="button">Unknown</button></div><button type="button" class="row" aria-expanded="false" aria-controls="b" data-acc-trigger>Second</button><div id="b" hidden><p>Second panel</p></div></section></main><script>document.querySelectorAll('[data-acc-trigger]').forEach(t=>t.onclick=()=>{const open=t.getAttribute('aria-expanded')!=='true';if(!${multi})document.querySelectorAll('[data-acc-trigger]').forEach(x=>{x.setAttribute('aria-expanded','false');document.getElementById(x.getAttribute('aria-controls')).hidden=true});t.setAttribute('aria-expanded',String(open));document.getElementById(t.getAttribute('aria-controls')).hidden=!open});</script></body></html>`;
const put = (path, value) => writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
function fixture(t) {
  mkdirSync('.local/tests', { recursive: true });
  const dir = mkdtempSync(resolve('.local/tests/conformance-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ui = join(dir, 'ui'); const code = join(dir, 'code'); const target = join(dir, 'target');
  for (const d of [join(ui, 'components/atoms'), code, target]) mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q', code]);
  put(join(ui, 'styles.css'), CSS); put(join(ui, 'design.html'), page().replace('<main data-conformance-root>', '<main data-conformance-root style="display:none">').replace('</main>', '</main><aside hidden><img loading="lazy" src="./not-requested.svg"></aside><script>setTimeout(()=>document.querySelector("main").style.display="",150)</script>'));
  put(join(ui, 'components/atoms/chip.html'), `<link rel="stylesheet" href="../../styles.css"><main>${BADGE}</main>`);
  put(join(ui, 'components/atoms/button.html'), `<link rel="stylesheet" href="../../styles.css"><main>${BUTTON}</main>`);
  put(join(target, 'index.html'), page(true, true)); put(join(target, 'styles.css'), CSS.replace('height:63px', 'height:70px').replace('font-weight:700', 'font-weight:600').replace('--chip-w-a:64px;', '').replace('width:var(--chip-w-a)', 'width:80px'));
  put(join(code, 'themes.css'), ':root{--chip-w-b:80px;--chip-h-b:28px;--chip-bg-a:#126839}');
  put(join(code, 'feature.tsx'), 'export const View=()=> <Chip onClick={() => go()} className="w-18 px-0">Active</Chip>;');
  put(join(code, 'other.tsx'), 'export const Other=()=> <Chip className="w-(--chip-w-b)" />;');
  put(join(dir, 'plan.html'), '<h1>Channels</h1>\n');
  put(join(dir, 'inputs.json'), { caseId: 'synthetic', inputs: [{ id: 'design', kind: 'design-html', role: 'design', path: join(ui, 'design.html') }, { id: 'plan', kind: 'plan-html', role: 'plan', path: join(dir, 'plan.html') }] });
  register(dir); extract(dir);
  return { dir, ui, code, target };
}

test('CLI는 URL·theme·source·code 인자를 검증한다', () => {
  assert.equal(parseArgs(['--root', 'a', '--url', 'http://localhost/', '--code', 'b', '--theme', 'dark']).root, 'a');
  for (const args of [[], ['a', '--url', 'file:///tmp/a', '--code', 'b'], ['a', '--url', 'http://localhost', '--code', 'b', '--theme', 'unknown'], ['a', '--url']]) assert.throws(() => parseArgs(args));
});

test('Chrome 부재는 skipped이며 이전 증거와 정책 검증을 보존한다', async t => {
  const { dir } = fixture(t);
  const registry = readJson(join(dir, 'sources.json'));
  const spec = seal({ schemaVersion: 1, kind: 'DesignSpec', sourceId: 'design', inputDigest: registry.sources.find(s => s.id === 'design').sha256, elements: [], interactions: [] });
  mkdirSync(join(dir, 'design-spec'));
  put(join(dir, 'design-spec/design.json'), spec);
  put(join(dir, 'component-baseline.json'), { digest: 'previous-baseline' });
  const before = readFileSync(join(dir, 'design-spec/design.json'), 'utf8');
  const status = await designSpec(dir, { env: { KH_CHROME: '/not-installed-chrome' } });
  assert.equal(readFileSync(join(dir, 'design-spec/design.json'), 'utf8'), before);
  assert.equal(readJson(join(dir, 'component-baseline.json')).digest, 'previous-baseline');
  assert.deepEqual(readDesignSpecs(dir, registry), [spec]);
  assert.equal(status.status, 'skipped'); assert.equal(status.reason, 'chrome 없음');
  const { report, exitCode } = await verify(dir, { url: 'http://localhost', code: dir, env: { KH_CHROME: '' } });
  assert.equal(report.status, 'skipped'); assert.equal(exitCode, 3);
  await assert.rejects(() => verify(dir, { url: 'http://localhost', code: join(dir, 'missing'), env: { KH_CHROME: '' } }), /--code/);
});

test('정적 서버는 상대 자산을 서빙하고 심볼릭 링크 이탈을 차단한다', async t => {
  const { dir, ui } = fixture(t); const server = await serve(ui); t.after(() => server.close());
  symlinkSync(join(dir, 'plan.html'), join(ui, 'escape.html'));
  assert.equal((await fetch(`${server.url}/styles.css`)).status, 200);
  assert.equal((await fetch(`${server.url}/escape.html`)).status, 403);
  put(join(ui, '.env'), 'private');
  assert.equal((await fetch(`${server.url}/.env`)).status, 403);
});

test('렌더 실패는 failed로 기록하며 이전 증거를 재사용하지 않는다', { skip: !findChrome() }, async t => {
  const { dir, ui, code } = fixture(t);
  rmSync(join(ui, 'styles.css'));
  await assert.rejects(() => designSpec(dir), /렌더/);
  assert.equal(readJson(join(dir, 'design-spec-status.json')).status, 'failed');
  await assert.rejects(() => verify(dir, { url: 'http://localhost/', code }), /design-spec 실패/);
});

test('렌더 증거는 단일 펼침·상대 좌표·클래스 size·토큰·테마를 결정적으로 수집한다', { skip: !findChrome() }, async t => {
  const { dir, ui } = fixture(t);
  put(join(ui, 'styles.css'), CSS + ':root{--tone-a:rgb(1,2,3);--tone-b:rgb(4,5,6)}main .emphasis{color:var(--tone-a)!important}.emphasis{color:var(--tone-b)}');
  const first = await designSpec(dir); const spec = readJson(join(dir, 'design-spec/design.json'));
  assert.equal(first.status, 'passed'); assert.equal(spec.interactions[0].openPolicy, 'single');
  assert.deepEqual(spec.interactions[0].initial, [false, false]); assert.equal(spec.interactions[0].reclick, 'close');
  const chip = spec.elements.find(e => e.componentName === 'chip');
  assert.equal(chip.rect.width, 64); assert.ok(chip.rect.x >= 0);
  assert.equal(chip.componentHint, null); assert.ok(chip.componentCandidates.length);
  assert.equal(chip.sizeAttribute, null);
  assert.ok(chip.classes.includes('h-7')); assert.ok(chip.utilities.includes('w-(--chip-w-a)'));
  assert.ok(chip.tokens.some(t => t.name === '--chip-w-a' && t.value === '64px'));
  assert.ok(chip.tokens.find(t => t.name === '--chip-w-a').definitions.some(d => d.value === '64px'));
  assert.equal(spec.render.theme, 'dark'); assert.equal(spec.render.contentReady, true); assert.ok(spec.elements.some(e => e.attributes.placeholder === 'Address'));
  assert.ok(spec.elements.find(e => e.text === 'Test').style.height === '41px');
  assert.ok(!('htmlLimit' in chip));
  const second = await designSpec(dir); assert.equal(first.digest, second.digest);
  assert.equal(spec.digest, readJson(join(dir, 'design-spec/design.json')).digest);
  const emphasis = spec.elements.find(e => e.text === 'Important').style.color;
  assert.equal(emphasis.value, 'rgb(1, 2, 3)');
  assert.deepEqual(emphasis.candidateTokens.map(c => c.token), ['--tone-a', '--tone-b']);
  assert.equal(emphasis.candidateTokens[0].important, true);
  put(join(ui, 'styles.css'), CSS.replace('height:63px', 'height:65px'));
  const third = await designSpec(dir); assert.notEqual(second.digest, third.digest);
});

// 합성 fixture의 정답을 반환하는 가짜 판정자. 제품의 판정 로직이 아니다.
function fixtureJudge(dir, facts) {
  return runConformance(dir, {env:{}}, {log:()=>{},runAgent:spec=>{
    const rows=facts.facts.map((f,i)=>{
      const design=facts.designs.find(d=>d.sourceId===f.sourceId)?.elements.find(e=>e.id===f.element);
      const row={id:`C${i+1}`,factIds:[f.id],observations:[{fact:f.id,implementation:f.candidates?.find(c=>c.implementation)?.implementation ?? null}],verdict:'match',reason:'합성 정답',evidence:[f.id],expected:'fabricated',actual:'fabricated'};
      if(f.kind==='jsx-classname') Object.assign(row,{verdict:'ds-override',expected:f.expected,actual:f.actual});
      else if(f.kind==='token-undefined') Object.assign(row,{verdict:'token-missing',expected:f.expected,actual:null});
      else if(f.kind==='interaction-observation') Object.assign(row,{verdict:'behavior-mismatch',expected:'single',actual:'multi',question:{to:'design',question:'펼침 규칙 확인'}});
      else if(design?.rect.height===63) Object.assign(row,{verdict:'gap',expected:63,actual:70});
      else if(design?.text==='Important') Object.assign(row,{verdict:'gap',expected:'700',actual:'600'});
      else if(design?.text==='Test') Object.assign(row,{verdict:'acceptable',expected:41,actual:40,evidence:[f.id,facts.baseline.samples.find(b=>b.componentLabel==='button').id]});
      else if(design?.text==='Unknown') row.verdict='needs-component';
      return row;
    });
    writeFileSync(join(spec.cwd,'stages/conformance.json'),JSON.stringify({factsDigest:facts.digest,rows}));
    return {ok:true,status:{status:'done'},tokens:1,seconds:0};
  }});
}

test('S8는 수집 차이와 선택된 후보의 수치를 판정 보고서에 주입한다', { skip: !findChrome() }, async t => {
  const { dir, code, target } = fixture(t);
  await designSpec(dir);
  const server = await serve(target); t.after(() => server.close());
  const { report, exitCode } = await verify(dir, { url: `${server.url}/`, code }, { judge: fixtureJudge });
  assert.equal(exitCode, 1);
  assert.ok(report.rows.some(r => r.expected.some(e => e.values?.['rect.height'] === 63) && r.actual.some(e => e.values?.['rect.height'] === 70)));
  assert.ok(report.rows.some(r => r.expected.some(e => e.values?.['style.font-weight'] === '700') && r.actual.some(e => e.values?.['style.font-weight'] === '600')));
  assert.ok(report.rows.some(r => r.expected.some(e => e.values?.['rect.height'] === 41) && r.actual.some(e => e.values?.['rect.height'] === 40)));
  assert.ok(report.rows.some(r => r.expected.some(e => e.values?.openPolicy === 'single') && r.actual.some(e => e.values?.openPolicy === 'multi')));
  const token = report.rows.find(r => r.verdict === 'token-missing' && r.expected[0].values?.token === '--chip-w-a');
  assert.equal(token.expected[0].values.value, '64px'); assert.ok(token.expected[0].values.classes.includes('w-(--chip-w-a)'));
  assert.ok(report.facts.find(f => f.kind === 'token-undefined').candidates.some(c => c.file === 'other.tsx'));
  assert.ok(report.rows.some(r => r.verdict === 'ds-override' && r.actual[0].values.classes.includes('w-18') && r.actual[0].values.classes.includes('px-0')));
  const facts = readJson(join(dir, 'conformance-facts.json'));
  assert.ok(facts.facts.some(f => f.candidates?.some(c => c.comparisons?.some(p => p.property === 'rect.height' && p.expected === 63 && p.actual === 70))));
  assert.ok(facts.facts.some(f => f.kind === 'interaction-observation' && f.observed.openPolicy === 'single' && f.candidates.some(c => c.observed.openPolicy === 'multi')));
  assert.ok(facts.facts.every(f => !('verdict' in f)));
  assert.deepEqual(judgmentErrors(report, facts), []);
  assert.ok(judgmentErrors({ ...report, rows: report.rows.slice(1) }, facts).some(e => e.includes('판정 누락')));
  assert.ok(judgmentErrors({ ...report, factsDigest: 'stale' }, facts).some(e => e.includes('factsDigest')));
  const review = readFileSync(join(dir, 'review.html'), 'utf8'); assert.ok(review.includes('시안 적합성')); assert.ok(review.includes('token-missing'));
  const brief = readFileSync(join(dir, 'conformance-brief.md'), 'utf8'); assert.ok(brief.includes('size/variant/prop')); assert.ok(brief.includes('--chip-w-a'));
  const repeated = await verify(dir, { url: `${server.url}/`, code }, { judge: fixtureJudge }); assert.equal(report.digest, repeated.report.digest);
  assert.equal((readFileSync(join(dir, 'review.html'), 'utf8').match(/id="sec-conformance"/g) ?? []).length, 1);
  let calls = 0;
  const codex = runConformance(dir, { force: true, env: { KH_CONFORMANCE_RUNNER: 'codex' } }, { log: () => {}, runAgent: spec => {
    calls++;
    assert.equal(spec.runner, 'codex'); assert.ok(spec.role.includes('observations')); assert.ok(!spec.role.includes('ASD-STE100'));
    if (calls === 2) assert.ok(spec.prompt.includes('판정 누락'));
    put(join(dir, 'stages/conformance.json'), { factsDigest: facts.digest, rows: calls === 1 ? report.rows.slice(1) : report.rows });
    return { ok: true, status: { status: 'done' }, tokens: 1, seconds: 0 };
  } });
  assert.equal(calls, 2); assert.equal(codex.report.status, 'failed');
});

test('토큰 선언·주석·JSX 다중 행·동적 className을 정적으로 검사한다', t => {
  const { dir, code } = fixture(t);
  put(join(code, 'feature.tsx'), 'const a = <OddWidget onClick={() => go({nested: {label: ">"}})}\n className={ok ? "w-[64px] h-8 text-[13px]" : "min-w-20"}\n/>;');
  put(join(code, 'themes.css'), '/* --missing:99px; */ :root{--present:12px}');
  const result = inspectCode(code, [{ sourceId: 'd', digest: 'x', elements: [{ id: 'e', kind: 'chip', classes: ['w-(--missing)'], tokens: [{ name: '--missing', value: '64px', definitions: [] }] }] }]);
  assert.ok(result.facts.some(r => r.kind === 'token-undefined'));
  assert.ok(result.facts.some(r => r.kind === 'jsx-classname' && r.line === 1));
  const classes = result.facts.find(r => r.kind === 'jsx-classname').actual.classes;
  assert.deepEqual(classes, ['w-[64px]', 'h-8', 'text-[13px]', 'min-w-20']);
  assert.equal(result.facts.find(r => r.kind === 'token-undefined').searched.root, code);
  assert.ok(result.definitions['--present']); assert.ok(!result.definitions['--missing']);
});

test('허용 오차는 사실이며 수용 판정을 자동 생성하지 않는다', () => {
  const e = { id: 'E1', kind: 'text', text: 'A', label: '', attributes: {}, reference: { kind: 'region', label: '' }, rect: { x: 0, y: 0, width: 20, height: 10 }, textRects: [], style: { 'font-weight': '700', 'padding-left': '10px' }, componentHint: null };
  const d = { sourceId: 'd', digest: 's', render: { theme: 'dark' }, elements: [e], interactions: [] };
  const z = structuredClone(d); z.elements[0].rect.width += 1; z.elements[0].rect.x += 1; z.elements[0].style['padding-left'] = '12px';
  z.elements[0].kind = 'region';
  const facts=compareFacts(d,z);
  assert.ok(facts[0].candidates[0].comparisons.find(p=>p.property==='rect.width').withinTolerance);
  assert.ok(facts.every(f=>!('verdict' in f)));
  assert.throws(() => compareFacts(d, z, { size: -1 }));
  assert.ok(facts[0].candidates[0].comparisons.some(p => p.property === 'kind' && p.equal === false));
  const candidates = componentCandidates([{ ...e, tag: 'span', classes: ['shared'] }], { samples: [{ id: 'B1', tag: 'span', componentLabel: 'unrelated-filename', classes: ['shared'] }] });
  assert.equal(candidates[0].componentCandidates[0].sharedClassCount, 1);
});

test('판정 게이트는 후보 쌍을 검증하고 거짓 수치를 사실로 교체한다', t => {
  const { dir } = fixture(t); mkdirSync(join(dir, 'stages'));
  const e = { id: 'E1', text: 'X', classes: [], kind: 'text', tag: 'span', rect: { x: 0, y: 0, width: 64, height: 28 }, style: {} };
  const design = { sourceId: 'd', elements: [e], interactions: [] };
  const implementation = { elements: [{ ...e, id: 'E19', rect: { ...e.rect, width: 65.39 } }], interactions: [] };
  const facts = { digest: 'f', facts: compareFacts(design, implementation), designs: [design], implementation, baseline: { samples: [] }, code: { existingPatterns: [], tokenDefinitions: {} } };
  const row = { id: 'C1', factIds: [facts.facts[0].id], observations: [{ fact: facts.facts[0].id, implementation: 'E19' }], verdict: 'match', reason: '의미 대응 판단', evidence: ['E19'], expected: 64, actual: 64 };
  const draft = { factsDigest: 'f', rows: [row] };
  put(join(dir, 'stages/conformance.json'), draft);
  const gated = conformanceGate(dir, facts);
  assert.deepEqual(gated.violations, []);
  assert.equal(gated.value.rows[0].expected[0].values['rect.width'], 64);
  assert.equal(gated.value.rows[0].actual[0].values['rect.width'], 65.39);
  assert.equal(groundJudgments(draft, facts).rows[0].actual[0].implementation, 'E19');
  assert.ok(judgmentErrors({ ...draft, rows: [{ ...row, observations: [{ fact: row.factIds[0], implementation: 'missing' }] }] }, facts).length);
  assert.ok(judgmentErrors({ ...draft, rows: [{ ...row, observations: [] }] }, facts).length);
  assert.ok(judgmentErrors({ ...draft, rows: [{ ...row, observations: [{ fact: row.factIds[0] }] }] }, facts).length);
  assert.ok(judgmentErrors({ ...draft, rows: [{ ...row, observations: [null] }] }, facts).length);
});

test('응답 없는 네트워크 실패를 기록하고 취소는 제외한다', async () => {
  for (const canceled of [false, true]) {
    const handlers = new Map();
    const browser = { version: 'fixture', on: (name, f) => { handlers.set(name, f); return () => handlers.delete(name); }, evaluate: async () => true,
      send: async name => { if (name === 'Page.navigate') { handlers.get('Network.requestWillBeSent')({ requestId: 'r1', request: { url: 'http://localhost/missing.css' } }); handlers.get('Network.loadingFailed')({ requestId: 'r1', canceled, errorText: 'net::ERR_CONNECTION_REFUSED' }); } return {}; } };
    if (canceled) assert.equal((await navigate(browser, 'http://localhost/')).assets.length, 0);
    else await assert.rejects(() => navigate(browser, 'http://localhost/'), /net::ERR_CONNECTION_REFUSED.*missing.css/);
    assert.equal(handlers.size, 0);
  }
});

function policyPlan(spec) {
  return { schemaVersion: 3, designSpecDigests: [spec.digest], surfaces: [{ sourceRefs: [{ sourceId: 'd' }] }], components: [], requirements: [{ id: 'R1', basis: 'source', category: 'ui', statement: '여러 행을 동시에 펼칠 수 있다', acceptance: ['동시 펼침'], sourceRefs: [{ sourceId: 'p', locator: 'L1' }] }], questions: [], decisions: [], designSpecs: [{ sourceId: 'd', element: 'I1', requirement: 'R1', verdict: 'strict', reason: '시안 동작', interaction: { openPolicy: 'multi' } }] };
}
test('출처 정책은 근거를 검사하고 동작 충돌 질문은 LLM이 작성한다', () => {
  const spec = seal({ sourceId: 'd', elements: [], interactions: [{ id: 'I1', openPolicy: 'single', items: [{ locator: '#first' }] }] });
  const registry = { sources: [{ id: 'd', role: 'design' }, { id: 'p', role: 'plan' }, { id: 'code', role: 'implementation' }] };
  const resolver = { resolve: (id, loc) => ({ ok: id !== 'missing' && loc !== 'missing' }) };
  const p = policyPlan(spec);
  let errors = validateDesignPolicy(p, registry, [spec], resolver);
  assert.ok(errors.some(e => e.includes('existing-pattern'))); assert.ok(errors.some(e => e.includes('동작 충돌')));
  p.requirements[0].sourcePolicy = { classification: 'existing-pattern', reason: '현재 패턴', evidence: [{ sourceId: 'code', locator: 'src/example.tsx:4' }] };
  p.questions.push({id:'Q',to:'design',kind:'confirm',impact:['R1'],designEvidence:{sourceId:'d',interaction:'I1'}});
  p.requirements[0].resolution='pending';p.designSpecs[0].question='Q';
  errors = validateDesignPolicy(p, registry, [spec], resolver);
  assert.deepEqual(errors, []); assert.equal(p.questions[0].to, 'design'); assert.equal(p.requirements[0].resolution, 'pending');
  assert.deepEqual(validateDesignPolicy({ ...p, schemaVersion: 2 }, registry, [spec], resolver), []);
  assert.deepEqual(validateDesignPolicy(p, registry, [], resolver), []);
  spec.elements.push({ id: 'E1', classes: ['h-7'], componentCandidates: [] });
  p.designSpecs.push({ sourceId: 'd', element: 'E1', verdict: 'component-rule', baseline: 'B1', reason: 'LLM이 별도 기준에서 대응을 확인함' });
  assert.deepEqual(validateDesignPolicy(p, registry, [spec], resolver, { samples: [{ id: 'B1' }] }), []);
  p.requirements[0].sourcePolicy.evidence[0].locator = 'missing'; assert.ok(validateDesignPolicy(p, registry, [spec], resolver).length);
});

test('새 envelope는 v3이며 렌더 skipped면 기존 계약으로 검증한다', async t => {
  const { dir } = fixture(t); await designSpec(dir, { env: { KH_CHROME: '' } });
  const refs = [{ sourceId: 'plan', locator: 'L1' }];
  const scope = { surfaces: [{ id: 'S', title: 'Channels', entry: '/', change: 'new', sourceRefs: refs }], excluded: [] };
  const draft = { ...scope, requirements: [{ id: 'R', surface: 'S', statement: 'X', acceptance: ['X'], basis: 'source', sourceRefs: refs }], states: [{ id: 'ST', surface: 'S', state: 'n/a', region: 'all', condition: 'none', display: 'n/a', basis: 'source', sourceRefs: refs }], components: [], apiBindings: [], i18n: [], gaps: [], questions: [], tasks: [], decisions: [] };
  mkdirSync(join(dir, 'stages')); put(join(dir, 'stages/workplan.draft.json'), draft);
  const r = interpretGate(dir, readJson(join(dir, 'sources.json')), scope);
  assert.deepEqual(r.violations, []); assert.equal(r.value.schemaVersion, 3);
  assert.deepEqual(validate(dir, { ...r.value, schemaVersion: 2 }), []);
  put(join(dir, 'design-spec-status.json'), seal({ schemaVersion: 1, kind: 'DesignSpecStatus', status: 'failed', reason: 'fixture' }));
  assert.deepEqual(validate(dir, { ...r.value, schemaVersion: 2 }), []);
  assert.ok(validate(dir, r.value).some(e => e.includes('design-spec 실패')));
});
