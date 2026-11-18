// 프로파일 명령의 CLI 진입점. scripts/<명령>.mjs 는 사례의 목적 프로파일이 가진 같은 이름의 구현을 실행한다 —
// 명령 경로는 프로파일과 무관하게 그대로이고, 무엇을 검증·렌더하는지는 프로파일이 정한다.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadProfile } from './profile.mjs';

export function runProfileCli(name, argv = process.argv.slice(2)) {
  const at = argv.indexOf('--root');
  const dir = at >= 0 ? argv[at + 1] : argv.find((a) => !a.startsWith('--'));
  let profile;
  try { profile = loadProfile(dir && existsSync(resolve(dir)) ? resolve(dir) : process.cwd()); } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(2); }
  const script = profile.cli?.[name];
  if (!script) { process.stderr.write(`목적 프로파일 ${profile.id} 에는 ${name} 명령이 없다\n`); process.exit(2); }
  const r = spawnSync(process.execPath, [script, ...argv], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
