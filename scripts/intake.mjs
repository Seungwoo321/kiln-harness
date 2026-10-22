#!/usr/bin/env node
// intake — 사람이 건넨 자료 목록(spec)으로 사례 폴더와 inputs.json 을 만들고, 등록·추출·카탈로그까지 돌려 미리보기를 낸다.
// 스킬(`start`)이 대화로 spec 을 모으고 이 스크립트를 부른다. 판별·복사·기록은 전부 결정적이다(LLM 없음).
//
// usage: node scripts/intake.mjs --spec <spec.json> [--root <cases 폴더>] [--dry] [--force]
//
// spec = {
//   "case": "kebab-case-이름",                     // 필수
//   "brief": "이번 작업이 무엇인지 1~3줄",            // 선택 — 모든 단계 프롬프트의 '작업 주제'
//   "previous": { "case": "이전-사례", "supersedes": {"새id": "이전id"} },   // 선택 — 후속 작업
//   "items": [
//     { "path": "/abs/기획.html", "role": "plan", "mode": "copy|reference", "id": "선택", "note": "선택", "kind": "선택(자동 판별 덮어쓰기)" },
//     { "path": "/abs/코드레포", "role": "implementation", "ref": "origin/main", "paths": ["src"], "note": "백엔드" }   // git 레포 → code(커밋 고정)
//   ]
// }
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { join, resolve, basename, extname, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROLES = ['plan', 'design', 'contract', 'implementation', 'context'];
const COPY_LIMIT = 25 * 1024 * 1024;
const SUPPORTED = {
  plan: '.html .htm .docx .md .txt', design: '.html .htm .js .jsx .ts .tsx .css .svg', contract: '.yaml .yml .json (또는 git 레포)',
  implementation: 'git 레포(디렉터리)', context: '.md .txt .docx .html .htm',
};

// 역할 × 확장자 → register 의 kind. 이미지·PDF 처럼 읽을 수 없는 형식은 거부하고 변환을 안내한다.
export function detectKind(role, file) {
  const ext = extname(file).toLowerCase();
  const html = ['.html', '.htm'].includes(ext);
  const text = ['.md', '.txt'].includes(ext);
  const asset = ['.js', '.jsx', '.ts', '.tsx', '.css', '.svg'].includes(ext);
  if (role === 'plan') { if (html) return 'plan-html'; if (ext === '.docx') return 'plan-doc'; if (text) return 'context-doc'; }
  if (role === 'design') { if (html) return 'design-html'; if (asset) return 'design-asset'; }
  if (role === 'contract') { if (['.yaml', '.yml', '.json'].includes(ext)) return 'api-contract'; }
  if (role === 'context') { if (text) return 'context-doc'; if (ext === '.docx') return 'plan-doc'; if (html) return 'plan-html'; }
  return null;
}

const slug = (s) => s.toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function gitRoot(dir) {
  try { return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

// cases 폴더: 명시 > KH_CASES_DIR > ./cases(있으면) > ./kiln-cases. 사례(입력·계획서)는 구현 세션이 참조하는 산출물이므로 숨김·휘발 폴더(.local 등)에 두지 않는다.
export function resolveRoot(explicit, cwd = process.cwd(), env = process.env) {
  if (explicit) return resolve(explicit);
  if (env.KH_CASES_DIR) return resolve(env.KH_CASES_DIR);
  if (existsSync(join(cwd, 'cases'))) return join(cwd, 'cases');
  return join(cwd, 'kiln-cases');
}

// 사례(업무 자료)는 플러그인 설치 폴더 안에 만들지 않는다. .git 이 있는 체크아웃(개발용)은 예외다.
export function insidePluginInstall(root, pluginRoot) {
  const r = resolve(root); const p = resolve(pluginRoot);
  return (r === p || r.startsWith(`${p}/`)) && !existsSync(join(p, '.git'));
}

// spec → 분류 결과(부수효과 없음). 오류는 모아서 한 번에 던진다.
export function classify(spec) {
  const errors = [];
  const warnings = [];
  if (!spec?.case || !/^[a-z0-9][a-z0-9-]*$/.test(spec.case)) errors.push('case 는 영문 소문자·숫자·하이픈 이름이어야 함 (예: notification-channel)');
  if (!Array.isArray(spec?.items) || spec.items.length === 0) errors.push('items 가 비었음 — 참조할 자료가 하나도 없다');
  const used = new Set();
  const items = (spec?.items ?? []).map((raw, i) => {
    const w = `items[${i}]`;
    const item = { ...raw, path: raw.path ? resolve(raw.path) : null };
    if (!ROLES.includes(item.role)) { errors.push(`${w}: role 은 ${ROLES.join('|')} 중 하나 (${item.role})`); return null; }
    if (!item.path || !existsSync(item.path)) { errors.push(`${w}: 경로가 없음 — ${raw.path}`); return null; }
    const st = statSync(item.path);
    let out;
    if (st.isDirectory()) {
      const root = gitRoot(item.path);
      if (!root) {
        const names = readdirSync(item.path).slice(0, 8).join(', ');
        errors.push(`${w}: git 레포가 아닌 폴더는 통째로 받지 않는다 — 읽을 파일을 하나씩 지정한다 (${basename(item.path)}: ${names}…)`);
        return null;
      }
      if (!['implementation', 'contract'].includes(item.role)) warnings.push(`${w}: git 레포를 ${item.role} 역할로 등록한다 — 보통 implementation·contract 이다`);
      const sub = root === item.path ? [] : [item.path.slice(root.length + 1)];
      out = { kind: 'code', repo: root, ref: item.ref ?? 'HEAD', paths: item.paths?.length ? item.paths : sub, mode: 'reference' };
    } else {
      const kind = item.kind ?? detectKind(item.role, item.path);
      if (!kind) { errors.push(`${w}: ${item.role} 역할로 읽을 수 없는 형식 — ${basename(item.path)}. 지원: ${SUPPORTED[item.role]} (이미지·PDF 는 텍스트나 HTML 로 변환해서 준다)`); return null; }
      const mode = item.mode ?? (st.size > COPY_LIMIT ? 'reference' : 'copy');
      out = { kind, mode, bytes: st.size };
    }
    let id = item.id ?? slug(basename(item.path));
    if (!id || used.has(id)) id = `${item.role}-${i + 1}`;
    used.add(id);
    return { id, role: item.role, note: item.note ?? null, source: item.path, ...out };
  }).filter(Boolean);
  if (!items.some((x) => x.role === 'plan')) errors.push('plan(기획) 역할의 자료가 없다 — 요구사항의 출처가 없으면 시작할 수 없다');
  for (const r of ['design', 'contract', 'implementation']) if (!items.some((x) => x.role === r)) warnings.push(`${r} 역할의 자료가 없다 — 카탈로그가 그 부재를 에이전트에게 알린다`);
  return { items, errors, warnings };
}

export function materialize(spec, root, { force = false } = {}) {
  const dir = join(root, spec.case);
  if (existsSync(join(dir, 'inputs.json')) && !force) throw new Error(`이미 있는 사례다 — ${dir} (다른 이름을 쓰거나 --force)`);
  const { items } = classify(spec);
  mkdirSync(dir, { recursive: true });
  const inputs = items.map((it) => {
    if (it.kind === 'code') return { id: it.id, kind: 'code', role: it.role, repo: it.repo, ref: it.ref, paths: it.paths, ...(it.ref === 'HEAD' ? { fetch: false } : {}), ...(it.note ? { note: it.note } : {}) };
    let path = it.source;
    if (it.mode === 'copy') {
      const to = join(dir, 'sources', it.role);
      mkdirSync(to, { recursive: true });
      let dest = join(to, basename(it.source));
      for (let n = 2; existsSync(dest) && !force; n += 1) dest = join(to, `${n}-${basename(it.source)}`);
      copyFileSync(it.source, dest);
      path = dest;
    }
    return { id: it.id, kind: it.kind, role: it.role, path, ...(it.note ? { note: it.note } : {}) };
  });
  writeFileSync(join(dir, 'inputs.json'), `${JSON.stringify({ caseId: spec.case, ...(spec.brief ? { brief: spec.brief } : {}), ...(spec.previous ? { previous: spec.previous } : {}), inputs }, null, 2)}\n`);
  return dir;
}

const run = (script, dir) => spawnSync('node', [join(HERE, script), dir], { encoding: 'utf8' });

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const opt = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };
  const specPath = opt('--spec');
  if (!specPath) { process.stderr.write('usage: node scripts/intake.mjs --spec <spec.json> [--root <cases 폴더>] [--dry] [--force]\n'); process.exit(2); }
  const spec = JSON.parse(readFileSync(resolve(specPath), 'utf8'));
  const root = resolveRoot(opt('--root'));
  if (insidePluginInstall(root, join(HERE, '..'))) { process.stderr.write(`사례 폴더를 플러그인 설치 폴더 안에 만들 수 없다 — 작업 폴더(주제 폴더)에서 실행하거나 --root 로 밖의 경로를 준다.\n  (${root})\n`); process.exit(1); }
  const { items, errors, warnings } = classify(spec);
  const table = items.map((x) => `  ${x.id.padEnd(22)} ${x.role.padEnd(15)} ${x.kind.padEnd(13)} ${x.kind === 'code' ? `git ${x.repo} @ ${x.ref}${x.paths.length ? ` [${x.paths.join(', ')}]` : ''}` : `${x.mode === 'copy' ? '복사' : '참조'} ← ${x.source}`}`).join('\n');
  if (errors.length) { process.stderr.write(`입력 정의를 만들 수 없다:\n${errors.map((e) => `  ✗ ${e}`).join('\n')}\n`); process.exit(1); }
  process.stdout.write(`사례: ${spec.case}  (폴더 ${join(root, spec.case)})\n${spec.brief ? `주제: ${spec.brief}\n` : ''}자료 ${items.length}건:\n${table}\n`);
  if (warnings.length) process.stdout.write(`경고:\n${warnings.map((w) => `  ! ${w}`).join('\n')}\n`);
  if (argv.includes('--dry')) { process.stdout.write('(dry — 아무것도 만들지 않았다)\n'); process.exit(0); }

  let dir;
  try { dir = materialize(spec, root, { force: argv.includes('--force') }); } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(1); }
  for (const step of ['register.mjs', 'extract.mjs', 'catalog.mjs']) {
    const r = run(step, dir);
    if (r.status !== 0) { process.stderr.write(`${step} 실패:\n${r.stderr || r.stdout}\n`); process.exit(1); }
    if (step === 'catalog.mjs') process.stdout.write(`\n참조 카탈로그:\n${r.stdout.split('\n').filter(Boolean).map((l) => `  ${l}`).join('\n')}\n`);
  }
  process.stdout.write(`\n다음 — 터미널에서 실행 (스킬 안에서 돌리지 않는다):\n  node ${join(HERE, 'run.mjs')} ${dir} --attempts 3 --loops 1\n  결과: ${join(dir, 'review.html')}\n`);
}
