import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { detectKind, classify, materialize, resolveRoot, insidePluginInstall } from './intake.mjs';

const CLI = join(import.meta.dirname, 'intake.mjs');
const OPENAPI = `openapi: 3.0.0\ninfo: {title: t, version: '1'}\npaths:\n  /v1/things:\n    get:\n      operationId: listThings\n      summary: 목록\n`;

function materials() {
  const d = mkdtempSync(join(tmpdir(), 'kh-in-'));
  const f = (name, body) => { const p = join(d, name); writeFileSync(p, body); return p; };
  const repo = join(d, 'repo'); mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  execFileSync('git', ['-C', repo, 'init', '-q']); execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'i']);
  return {
    d, repo,
    plan: f('기획.html', '<html><body>\n<h1 id="p">화면</h1>\n<p>본문</p>\n</body></html>\n'),
    design: f('시안.html', '<html><body>\n<h1 id="d">시안</h1>\n</body></html>\n'),
    spec: f('api.yaml', OPENAPI),
    ctx: f('결정.md', '# 확정\n\n## 규칙\n\n- 전체 마스킹\n'),
    png: f('시안.png', 'x'),
  };
}
const spec = (m, over = {}) => ({ case: 'sample-case', brief: '샘플 작업', items: [
  { path: m.plan, role: 'plan' }, { path: m.design, role: 'design' }, { path: m.spec, role: 'contract' },
  { path: m.ctx, role: 'context', note: '확정 결정' }, { path: m.repo, role: 'implementation', paths: ['src'] }], ...over });

test('형식 판별: 역할 × 확장자', () => {
  assert.equal(detectKind('plan', 'a.html'), 'plan-html'); assert.equal(detectKind('plan', 'a.docx'), 'plan-doc'); assert.equal(detectKind('plan', 'a.md'), 'context-doc');
  assert.equal(detectKind('design', 'a.html'), 'design-html'); assert.equal(detectKind('design', 'a.js'), 'design-asset');
  assert.equal(detectKind('contract', 'a.yaml'), 'api-contract'); assert.equal(detectKind('context', 'a.md'), 'context-doc');
  assert.equal(detectKind('design', 'a.png'), null); assert.equal(detectKind('plan', 'a.pdf'), null); assert.equal(detectKind('implementation', 'a.ts'), null);
});

test('분류: 거부 사유를 모아서 알려 준다', () => {
  const m = materials();
  const bad = classify({ case: 'Bad Name', items: [{ path: m.png, role: 'design' }, { path: join(m.d, '없는파일.html'), role: 'plan' }, { path: m.d, role: 'context' }, { path: m.plan, role: 'nope' }] });
  const text = bad.errors.join('\n');
  assert.ok(text.includes('case 는 영문 소문자') && text.includes('읽을 수 없는 형식') && text.includes('경로가 없음') && text.includes('git 레포가 아닌 폴더') && text.includes('role 은'));
  assert.ok(text.includes('plan(기획) 역할의 자료가 없다'));
});

test('분류: 한글 파일명은 역할-순번 id 로, 없는 역할은 경고로 알린다', () => {
  const m = materials();
  const r = classify({ case: 'c1', items: [{ path: m.plan, role: 'plan' }, { path: m.design, role: 'design' }] });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.items.map((x) => x.id), ['plan-1', 'design-2']);
  assert.ok(r.warnings.some((w) => w.startsWith('contract')) && r.warnings.some((w) => w.startsWith('implementation')));
});

test('생성: 파일은 복사, 레포는 참조(커밋 고정), brief·previous 기록', () => {
  const m = materials(); const root = mkdtempSync(join(tmpdir(), 'kh-root-'));
  const dir = materialize(spec(m, { previous: { case: 'old' }, items: [...spec(m).items, { path: m.d + '/', role: 'context', mode: 'reference' }].slice(0, 5) }), root);
  const inputs = JSON.parse(readFileSync(join(dir, 'inputs.json'), 'utf8'));
  assert.equal(inputs.caseId, 'sample-case'); assert.equal(inputs.brief, '샘플 작업'); assert.deepEqual(inputs.previous, { case: 'old' });
  const byRole = Object.fromEntries(inputs.inputs.map((i) => [i.role, i]));
  assert.ok(byRole.plan.path.startsWith(join(dir, 'sources', 'plan')) && existsSync(byRole.plan.path)); // 복사
  assert.equal(readFileSync(byRole.plan.path, 'utf8'), readFileSync(m.plan, 'utf8'));
  assert.equal(byRole.contract.kind, 'api-contract'); assert.equal(byRole.context.note, '확정 결정');
  assert.equal(byRole.implementation.kind, 'code'); assert.equal(byRole.implementation.ref, 'HEAD'); assert.equal(byRole.implementation.fetch, false); assert.deepEqual(byRole.implementation.paths, ['src']);
});

test('생성: mode:reference 는 원래 경로를 가리키고, 같은 이름은 덮지 않는다', () => {
  const m = materials(); const root = mkdtempSync(join(tmpdir(), 'kh-root-'));
  const dir = materialize({ case: 'c2', items: [{ path: m.plan, role: 'plan', mode: 'reference' }] }, root);
  assert.equal(JSON.parse(readFileSync(join(dir, 'inputs.json'), 'utf8')).inputs[0].path, m.plan);
  assert.ok(!existsSync(join(dir, 'sources')));
  assert.throws(() => materialize({ case: 'c2', items: [{ path: m.plan, role: 'plan' }] }, root), /이미 있는 사례/);
  assert.ok(materialize({ case: 'c2', items: [{ path: m.plan, role: 'plan' }] }, root, { force: true }));
});

test('cases 폴더 결정: 명시 > 환경변수 > ./cases > ./kiln-cases (.local 같은 숨김 폴더는 고르지 않는다)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kh-cwd-'));
  assert.equal(resolveRoot('/x/y', cwd, {}), '/x/y');
  assert.equal(resolveRoot(null, cwd, { KH_CASES_DIR: '/e/c' }), '/e/c');
  assert.equal(resolveRoot(null, cwd, {}), join(cwd, 'kiln-cases'));
  mkdirSync(join(cwd, '.local'));
  assert.equal(resolveRoot(null, cwd, {}), join(cwd, 'kiln-cases')); // .local 이 있어도 쓰지 않는다
  mkdirSync(join(cwd, 'cases'));
  assert.equal(resolveRoot(null, cwd, {}), join(cwd, 'cases'));
});

test('사례 폴더는 플러그인 설치 폴더 안에 만들지 않는다(개발용 git 체크아웃은 예외)', () => {
  const plugin = mkdtempSync(join(tmpdir(), 'kh-plugin-'));
  assert.equal(insidePluginInstall(join(plugin, 'cases'), plugin), true);
  assert.equal(insidePluginInstall(plugin, plugin), true);
  assert.equal(insidePluginInstall(join(tmpdir(), 'elsewhere'), plugin), false);
  mkdirSync(join(plugin, '.git'));
  assert.equal(insidePluginInstall(join(plugin, 'cases'), plugin), false);
});

test('명령줄: 만들고 등록·추출·카탈로그까지 돌려 미리보기와 다음 명령을 보여 준다', () => {
  const m = materials(); const root = mkdtempSync(join(tmpdir(), 'kh-root-'));
  const specFile = join(m.d, 'spec.json'); writeFileSync(specFile, JSON.stringify(spec(m)));
  const dry = spawnSync('node', [CLI, '--spec', specFile, '--root', root, '--dry'], { encoding: 'utf8' });
  assert.equal(dry.status, 0); assert.ok(dry.stdout.includes('아무것도 만들지 않았다')); assert.ok(!existsSync(join(root, 'sample-case')));
  const r = spawnSync('node', [CLI, '--spec', specFile, '--root', root], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('참조 카탈로그') && r.stdout.includes('node ') && r.stdout.includes('run.mjs') && r.stdout.includes('review.html'));
  const dir = join(root, 'sample-case');
  const reg = JSON.parse(readFileSync(join(dir, 'sources.json'), 'utf8'));
  assert.equal(reg.brief, '샘플 작업'); assert.equal(reg.sources.length, 5);
  const ops = JSON.parse(readFileSync(join(dir, 'extract', 'api.json'), 'utf8')).anchors.filter((a) => a.type === 'operation');
  assert.deepEqual(ops.map((a) => a.value), ['listThings']); // 파일로 들어온 API 스펙에서 operation 추출
  const cat = JSON.parse(readFileSync(join(dir, 'references.json'), 'utf8'));
  assert.equal(cat.brief, '샘플 작업'); assert.deepEqual(cat.missingRoles, []);
  const bad = spawnSync('node', [CLI, '--spec', specFile, '--root', root], { encoding: 'utf8' });
  assert.equal(bad.status, 1); assert.ok(bad.stderr.includes('이미 있는 사례'));
});

test('작업 주제(brief)는 모든 단계 프롬프트에 들어간다', async () => {
  const { catalogText } = await import('./catalog.mjs');
  assert.ok(catalogText({ brief: '내보내기 기능 추가', sources: [], warnings: [] }).includes('[작업 주제]\n내보내기 기능 추가'));
  assert.ok(!catalogText({ sources: [], warnings: [] }).includes('[작업 주제]'));
});
