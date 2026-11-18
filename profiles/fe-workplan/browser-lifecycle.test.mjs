import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { findChrome } from './lib/browser.mjs';

test('SIGTERM·SIGINT·exit는 소유한 Chrome과 렌더 폴더를 정리한다', { skip: !findChrome() || process.platform === 'win32', timeout: 30000 }, async t => {
  mkdirSync('.local/tests', { recursive: true });
  for (const signal of ['SIGTERM', 'SIGINT', 'exit']) {
    const scratch = mkdtempSync(resolve('.local/tests/lifecycle-'));
    const script = `import {launchBrowser} from ${JSON.stringify(new URL('./lib/browser.mjs', import.meta.url).href)};
      import {rmSync} from 'node:fs';
      await launchBrowser(${JSON.stringify(findChrome())}, ${JSON.stringify(scratch)}, () => rmSync(${JSON.stringify(scratch)}, {recursive:true,force:true}));
      process.on('message', () => process.exit(0)); process.stdout.write('ready');`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] });
    const owned = () => execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').filter(line => line.includes(`--user-data-dir=${scratch}/chrome-`));
    t.after(() => { child.kill('SIGKILL'); for (const line of owned()) { try { process.kill(Number(line.trim().split(/\s+/)[0]), 'SIGKILL'); } catch { /* 종료됨 */ } } rmSync(scratch, { recursive: true, force: true }); });
    await once(child.stdout, 'data', { signal: AbortSignal.timeout(10000) });
    assert.ok(owned().length, '시그널 전에 실제 Chrome이 실행 중이어야 함');
    const ended = once(child, 'exit', { signal: AbortSignal.timeout(8000) });
    if (signal === 'exit') child.send('exit'); else child.kill(signal);
    const [code] = await ended;
    assert.equal(code, signal === 'SIGTERM' ? 143 : signal === 'SIGINT' ? 130 : 0);
    assert.equal(existsSync(scratch), false);
    // exit 핸들러는 동기라 SIGKILL을 보내고 기다리지 않는다. 종료는 OS가 비동기로 마치므로 제한 시간 안의 정리를 확인한다.
    let remaining = owned();
    for (const deadline = Date.now() + 5000; remaining.length && Date.now() < deadline; remaining = owned()) await new Promise(r => setTimeout(r, 100));
    assert.deepEqual(remaining, [], `${signal} 뒤 5초 안에 Chrome이 끝나야 함`);
  }
});
