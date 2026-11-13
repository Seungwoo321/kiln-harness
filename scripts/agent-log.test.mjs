import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderClaudeLine, render, toolLabel, createCodexRenderer } from './agent-log.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const j = (o) => JSON.stringify(o);

test('에이전트 기록: 도구 호출은 이름(핵심 인자), 결과는 앞 3줄과 남은 줄 수로 보인다', () => {
  assert.equal(toolLabel('Bash', { command: 'ls', description: '목록 보기' }), 'Bash(목록 보기)');
  assert.equal(toolLabel('Read', { file_path: '/a/b.md' }), 'Read(/a/b.md)');
  const call = renderClaudeLine(j({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'foo' } }] } }));
  assert.ok(call.some((l) => l.includes('Grep(foo)')));
  const res = renderClaudeLine(j({ type: 'user', message: { content: [{ type: 'tool_result', content: '1\n2\n3\n4\n5' }] } }));
  assert.ok(res[0].includes('⎿') && res.at(-1).includes('+2줄'));
  assert.equal(renderClaudeLine(j({ type: 'user', message: { content: [{ type: 'tool_result', content: '1\n2\n3\n4\n5' }] } }), { full: true }).length, 5);
});

test('에이전트 기록: 생각은 자리와 추정 토큰으로 보이고(본문이 있으면 요약), rate limit 은 숨긴다', () => {
  assert.deepEqual(renderClaudeLine(j({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50 })), []);
  assert.deepEqual(renderClaudeLine(j({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 1200 })), []);
  const t = renderClaudeLine(j({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }] } }));
  assert.ok(t.at(-1).includes('생각') && t.at(-1).includes('1,200'));
  assert.ok(!renderClaudeLine(j({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }] } })).at(-1).includes('토큰'));
  assert.ok(renderClaudeLine(j({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '계획을 세운다' }] } })).at(-1).includes('계획을 세운다'));
  assert.deepEqual(renderClaudeLine(j({ type: 'rate_limit_event' })), []);
});

test('에이전트 기록: 거부·실패·끝은 보인다', () => {
  assert.ok(renderClaudeLine(j({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', message: 'no' }))[0].includes('거부'));
  assert.ok(renderClaudeLine(j({ type: 'result', is_error: false, duration_ms: 2000, total_cost_usd: 1.5, usage: { input_tokens: 1, output_tokens: 2 } })).at(-1).includes('$1.50'));
  assert.ok(renderClaudeLine(j({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'boom' }] } }))[0].includes('✗'));
});

const codexLog = [
  'OpenAI Codex v1.0', '--------', 'workdir: /work', 'model: example-model',
  'session id: example-session', '--------', 'user', 'large input prompt', '',
  'exec', '/bin/zsh -lc "printf one" in /work', ' succeeded in 12ms:',
  'one', 'two', 'three', 'four', 'five', '',
  'exec', '/bin/zsh -lc "false" in /work', ' exited 1 in 2ms:', '',
  'codex', 'Finished checking files.', 'tokens used', '1,234',
].join('\n');

test('Codex 기록은 세션·명령·축약 결과·실패·메시지·토큰으로 정리한다', () => {
  const out = render(codexLog).join('\n');
  assert.match(out, /세션 example-session · 모델 example-model · cwd \/work/);
  assert.doesNotMatch(out, /large input prompt/);
  assert.match(out, /⏺ Bash\(\/bin\/zsh -lc "printf one" in \/work\)/);
  assert.match(out, /… \+2줄/);
  assert.doesNotMatch(out, /four|five/);
  assert.match(out, /✗ exited 1/);
  assert.match(out, /출력 없음/);
  assert.match(out, /⏺ 에이전트\nFinished checking files\./);
  assert.match(out, /끝 · 토큰 1,234/);
});

test('Codex full은 여러 줄 명령과 긴 결과를 생략하지 않는다', () => {
  const command = '/bin/zsh -lc "python3 - <<\'PY\'\nprint(1)\nPY" in /work';
  const log = codexLog.replace('/bin/zsh -lc "printf one" in /work', command);
  const out = render(log, { full: true }).join('\n');
  assert.ok(out.includes(command));
  assert.match(out, /four\n    five/);
  assert.doesNotMatch(out, /… \+\d+줄/);
});

test('Codex 스트리밍은 줄 단위 재호출에서도 일괄 출력과 같고 세션 상태를 격리한다', () => {
  const stream = createCodexRenderer();
  const out = codexLog.split('\n').flatMap((line) => stream.line(line));
  assert.deepEqual([...out, ...stream.flush()], render(codexLog));
  assert.deepEqual(stream.flush(), []);
  assert.deepEqual(render('unrecognized log\nplain text'), ['unrecognized log', 'plain text']);
  assert.match(render('OpenAI Codex v1\nuser\nERROR: login required').join('\n'), /✗ ERROR: login required/);
});

test('Codex 본문의 마커 단어는 명령·프롬프트 경계를 바꾸지 않는다', () => {
  const prompt = 'OpenAI Codex v1\nuser\nthinking\nprivate prompt\nexec\nnot a command\n';
  const log = prompt + 'exec\n/bin/zsh -lc "cat file" in /work\n succeeded in 1ms:\none\nexec\ntwo\nthree\n\nexec\nplain output\n\ncodex\nDone';
  const out = render(log, { full: true }).join('\n');
  assert.doesNotMatch(out, /private prompt|not a command/);
  assert.match(out, /one\n    exec\n    two\n    three/);
  assert.match(out, /exec\n    plain output/);
  assert.equal((out.match(/⏺ Bash\(/g) ?? []).length, 1);
  const multiline = render('exec\n/bin/zsh -lc "cat <<EOF\ncodex\nthinking\nexec\nEOF" in /work\n succeeded in 0ms:\nok\n', { full: true }).join('\n');
  assert.match(multiline, /cat <<EOF\ncodex\nthinking\nexec\nEOF/);
  assert.match(render('exec\n/bin/zsh -lc "echo exec" in /work\n succeeded in 0ms:\nexec', { full: true }).join('\n'), /    exec/);
});

test('도구 없는 Codex 응답과 첫 도구 전 에이전트 메시지도 표시한다', () => {
  const log = 'OpenAI Codex v1\nuser\nprompt\n\ncodex\nNo tools needed.\ntokens used\n123';
  assert.match(render(log).join('\n'), /⏺ 에이전트\nNo tools needed\./);
  assert.match(render(log).join('\n'), /끝 · 토큰 123/);
  assert.match(render(log.replace('tokens used\n123', 'exec\n/bin/zsh -lc "pwd" in /work\n succeeded in 0ms:\nok')).join('\n'), /No tools needed\./);
  for (const diagnostic of ['warning: Combined user instructions exceed the limit.', 'mcp startup: no servers']) {
    assert.match(render(log.replace('\n\ncodex', `\n\n${diagnostic}\ncodex`)).join('\n'), /No tools needed\./);
  }
});

test('full은 명령 경로와 결과의 긴 줄·빈 줄·공백을 보존한다', () => {
  const command = '/bin/zsh -lc "cat /work/file" in /work';
  const body = ['긴 결과'.repeat(100), '   ', '', 'error: literal output', '', ''];
  const log = ['OpenAI Codex v1', 'workdir: /work', 'user', 'prompt', 'exec', command, ' succeeded in 1ms:', ...body, '', 'codex', 'done'].join('\n');
  const out = render(log, { full: true });
  assert.ok(out.includes(`⏺ Bash(${command})`));
  const start = out.indexOf('  ⎿ succeeded in 1ms:') + 1;
  assert.deepEqual(out.slice(start, start + body.length), body.map(line => `    ${line}`));
  assert.doesNotMatch(out.join('\n'), /… \+\d+줄/);
  assert.match(render(log).join('\n'), /… \+3줄/);
  const unfinished = 'exec\n/bin/zsh -lc "printf" in /work\n succeeded in 1ms:\n   \n';
  const whitespace = render(unfinished, { full: true });
  assert.ok(whitespace.includes('       '));
  assert.ok(!whitespace.some(line => line.includes('출력 없음')));
});

test('완료 토큰 뒤의 같은 최종 상태는 중복하지 않고 다른 상태와 도구 출력은 보존한다', () => {
  const status = JSON.stringify({ status: 'done', message: '완료', missingInputs: [] });
  const log = ['codex', status, 'tokens used', '123', status].join('\n');
  assert.equal(render(log, { full: true }).filter(line => line === status).length, 1);
  const different = JSON.stringify({ status: 'blocked', message: '입력 필요', missingInputs: ['spec'] });
  assert.ok(render(log + '\n' + different).includes(different));
  const result = ['exec', '/bin/zsh -lc "cat status" in /work', ' succeeded in 1ms:', status, status, '', 'codex', 'done'].join('\n');
  assert.equal(render(result, { full: true }).filter(line => line === `    ${status}`).length, 2);
});

test('follow full은 읽기 사이에 나뉜 UTF-8 문자를 손상하지 않는다', { timeout: 10000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'kh-log-full-'));
  const stages = join(dir, 'stages'); mkdirSync(stages);
  const file = join(stages, '.agent-scope-1.log');
  const word = Buffer.from('한글 결과');
  writeFileSync(file, Buffer.concat([Buffer.from('exec\n/bin/zsh -lc "pwd" in /work\n succeeded in 1ms:\n'), word.subarray(0, 1)]));
  const child = spawn(process.execPath, [new URL('./agent-log.mjs', import.meta.url).pathname, dir, '--follow', '--full']);
  t.after(() => { child.kill(); rmSync(dir, { recursive: true, force: true }); });
  let out = ''; child.stdout.on('data', data => { out += data.toString(); });
  const waitFor = async text => { const deadline = Date.now() + 4000; while (!out.includes(text) && Date.now() < deadline) await delay(20); assert.ok(out.includes(text), out); };
  await waitFor('succeeded in 1ms:');
  appendFileSync(file, Buffer.concat([word.subarray(1), Buffer.from('\n\ncodex\n완료\ntokens used\n1\n')]));
  await waitFor('끝 · 토큰 1');
  assert.ok(out.includes('한글 결과'));
  assert.ok(!out.includes('�'));
});
