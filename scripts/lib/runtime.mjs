// 실행 중에 플러그인이 업데이트되면 설치 폴더(버전 캐시)가 지워진다. 모듈은 이미 올라와 있어도 역할·문서·설정은 단계마다 다시 읽으므로
// 실행은 설치 폴더가 아니라 내용 주소 스냅샷에서 돈다. 스냅샷은 쓰고 나면 바꾸지 않으므로 같은 내용의 실행끼리 공유해도 안전하다.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNTIME_ENTRIES = ['package.json', 'kh.config.json', 'scripts', 'roles', 'docs'];
const MARK = 'KH_RUNTIME_SNAPSHOT';

const filesUnder = (root, p) => {
  const abs = join(root, p);
  if (!existsSync(abs)) return [];
  if (!statSync(abs).isDirectory()) return [p];
  return readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((e) => (e.isSymbolicLink() ? [] : filesUnder(root, `${p}/${e.name}`)));
};

export function runtimeDigest(root) {
  const hash = createHash('sha256');
  for (const f of RUNTIME_ENTRIES.flatMap((e) => filesUnder(root, e))) hash.update(`${f}\0`).update(readFileSync(join(root, f))).update('\0');
  return hash.digest('hex').slice(0, 16);
}

export const runtimeStore = (env = process.env) => resolve(env.KH_RUNTIME_DIR ?? join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'kiln-harness', 'runtime'));

// 같은 내용의 스냅샷이 있으면 그대로 쓴다. 없으면 임시 폴더에 복사한 뒤 이름을 바꿔 원자적으로 만든다.
export function snapshotRuntime(root, store = runtimeStore()) {
  const target = join(store, runtimeDigest(root));
  if (existsSync(target)) return target;
  mkdirSync(store, { recursive: true });
  const tmp = `${target}.partial-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  for (const e of RUNTIME_ENTRIES) if (existsSync(join(root, e))) cpSync(join(root, e), join(tmp, e), { recursive: true });
  try { renameSync(tmp, target); } catch (e) { rmSync(tmp, { recursive: true, force: true }); if (!existsSync(target)) throw e; }
  return target;
}

// 스냅샷 밖에서 시작했으면 스냅샷의 같은 스크립트로 다시 실행하고 그 종료 코드를 돌려준다. 이미 스냅샷 안이면 null.
export async function relaunchFromSnapshot(scriptUrl, argv, env = process.env) {
  const script = fileURLToPath(scriptUrl);
  const root = resolve(dirname(script), '..');
  if (env[MARK]) return null; // 스냅샷에서 띄운 자식은 다시 띄우지 않는다(경로 비교는 심볼릭 링크 해석 차이로 어긋날 수 있다)
  const snap = snapshotRuntime(root, runtimeStore(env));
  const child = spawn(process.execPath, [join(snap, relative(root, script)), ...argv], { stdio: 'inherit', env: { ...env, [MARK]: snap } });
  // 터미널의 Ctrl-C 는 같은 프로세스 그룹의 자식도 받는다. 부모는 자식이 정리를 마칠 때까지 기다리고, 부모에게만 온 SIGTERM 은 넘긴다.
  const onInt = () => {}; const onTerm = () => child.kill('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  const [code, signal] = await new Promise((yes, no) => { child.once('error', no); child.once('exit', (c, s) => yes([c, s])); });
  process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
  return code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
}
