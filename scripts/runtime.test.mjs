import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeDigest, snapshotRuntime } from './lib/runtime.mjs';

function fakeInstall(base) {
  const root = join(base, 'install');
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true }); mkdirSync(join(root, 'roles'), { recursive: true });
  cpSync(new URL('./lib/runtime.mjs', import.meta.url), join(root, 'scripts', 'lib', 'runtime.mjs'));
  writeFileSync(join(root, 'roles', 'interpret.md'), '역할 v1');
  writeFileSync(join(root, 'kh.config.json'), '{}');
  return root;
}

test('스냅샷은 내용 주소다 — 같은 내용은 같은 폴더, 내용이 바뀌면 새 폴더', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'kh-runtime-')); t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = fakeInstall(base); const store = join(base, 'store');
  const a = snapshotRuntime(root, store);
  assert.equal(snapshotRuntime(root, store), a);
  assert.equal(readFileSync(join(a, 'roles', 'interpret.md'), 'utf8'), '역할 v1');
  writeFileSync(join(root, 'roles', 'interpret.md'), '역할 v2');
  const b = snapshotRuntime(root, store);
  assert.notEqual(b, a);
  assert.equal(readFileSync(join(a, 'roles', 'interpret.md'), 'utf8'), '역할 v1', '기존 스냅샷은 바뀌지 않는다');
  assert.equal(runtimeDigest(b), b.split('/').pop());
});

test('실행 중 설치 폴더가 지워져도 다음 단계는 역할 파일을 읽는다', { timeout: 20000 }, async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'kh-runtime-')); t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = fakeInstall(base);
  // 단계 사이에 역할 파일을 늦게 읽는 run.mjs 의 축소판
  writeFileSync(join(root, 'scripts', 'probe.mjs'), `import { relaunchFromSnapshot } from './lib/runtime.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const code = await relaunchFromSnapshot(import.meta.url, process.argv.slice(2));
if (code !== null) process.exit(code);
const go = process.argv[2];
process.stdout.write('ready\\n');
while (!existsSync(go)) await new Promise((r) => setTimeout(r, 20));
process.stdout.write(readFileSync(fileURLToPath(new URL('../roles/interpret.md', import.meta.url)), 'utf8'));`);
  const go = join(base, 'go');
  const child = spawn(process.execPath, [join(root, 'scripts', 'probe.mjs'), go], { env: { ...process.env, KH_RUNTIME_DIR: join(base, 'store'), KH_RUNTIME_SNAPSHOT: '' }, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = ''; child.stdout.on('data', (b) => { out += b; });
  while (!out.includes('ready')) await once(child.stdout, 'data');
  rmSync(root, { recursive: true, force: true }); // 플러그인 업데이트가 이전 버전 캐시를 지운다
  writeFileSync(go, '');
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  assert.equal(existsSync(root), false);
  assert.match(out, /역할 v1$/);
});
