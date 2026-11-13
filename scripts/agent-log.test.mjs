import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderClaudeLine, render, toolLabel } from './agent-log.mjs';

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

test('에이전트 기록: 생각 토큰·rate limit 은 숨기고, 거부·실패·끝은 보인다', () => {
  assert.deepEqual(renderClaudeLine(j({ type: 'system', subtype: 'thinking_tokens' })), []);
  assert.deepEqual(renderClaudeLine(j({ type: 'rate_limit_event' })), []);
  assert.deepEqual(renderClaudeLine(j({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }] } })), []);
  assert.ok(renderClaudeLine(j({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', message: 'no' }))[0].includes('거부'));
  assert.ok(renderClaudeLine(j({ type: 'result', is_error: false, duration_ms: 2000, total_cost_usd: 1.5, usage: { input_tokens: 1, output_tokens: 2 } })).at(-1).includes('$1.50'));
  assert.ok(renderClaudeLine(j({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'boom' }] } }))[0].includes('✗'));
});

test('에이전트 기록: codex 출력(JSON 아님)은 그대로 보인다', () => {
  assert.deepEqual(render('codex\nexec 줄'), ['codex', 'exec 줄']);
});
