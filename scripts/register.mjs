#!/usr/bin/env node
// S1 register — 사례의 inputs.json 을 읽어 각 원본의 sha256·크기를 sources.json 으로 기록한다.
// usage: node scripts/register.mjs <case-dir>
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';

const KINDS = new Set(['plan-html', 'plan-doc', 'design-html', 'design-asset', 'api-contract', 'code', 'context-doc']);
const ROLES = new Set(['plan', 'design', 'contract', 'implementation', 'context']);

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function fail(msg) {
  process.stderr.write(`register: ${msg}\n`);
  process.exit(2);
}

// code 원본은 git ref 의 트리를 가리킨다 — 작업 트리 상태가 아니라 커밋으로 고정해야 재현된다.
function describeCode(input) {
  const { repo, ref, paths = [] } = input;
  if (!repo || !ref) fail(`${input.id}: code 원본에는 repo·ref 가 필요합니다`);
  // 원격 ref(origin/<branch>)면 등록 직전에 받아 와서 항상 최신 커밋으로 고정한다. 결과는 commit 으로 남아 재현된다.
  const remote = ref.match(/^([\w.-]+)\/(.+)$/);
  if (remote && input.fetch !== false) {
    const remotes = execFileSync('git', ['-C', repo, 'remote'], { encoding: 'utf8' }).split('\n');
    if (remotes.includes(remote[1])) execFileSync('git', ['-C', repo, 'fetch', '--quiet', remote[1], remote[2]], { stdio: ['ignore', 'ignore', 'inherit'] });
  }
  const commit = execFileSync('git', ['-C', repo, 'rev-parse', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
  const tree = execFileSync('git', ['-C', repo, 'ls-tree', '-r', commit, '--', ...paths], { encoding: 'utf8' });
  return { repo, ref, commit, paths, sha256: sha256(tree), entries: tree.split('\n').filter(Boolean).length };
}

function describeFile(input) {
  if (!input.path) fail(`${input.id}: path 가 필요합니다`);
  if (!existsSync(input.path)) fail(`${input.id}: 파일이 없습니다 — ${input.path}`);
  return { path: input.path, sha256: sha256(readFileSync(input.path)), bytes: statSync(input.path).size };
}

// 후속 사례: 이전 사례를 링크로 건다. 등록 digest 에 이전 계획서의 digest 가 들어가므로 이전 사례가 바뀌면 이 사례도 다시 돌아간다.
export const previousDir = (caseDir, previousCase) => (isAbsolute(previousCase) ? previousCase : resolve(caseDir, '..', previousCase));

function describePrevious(caseDir, previous) {
  if (!previous?.case) fail('previous 에는 case(이전 사례 폴더 — 절대경로 또는 같은 cases/ 아래 이름)가 필요합니다');
  const dir = previousDir(caseDir, previous.case);
  const regPath = join(dir, 'sources.json');
  const planPath = join(dir, 'workplan.json');
  if (!existsSync(regPath) || !existsSync(planPath)) fail(`previous: 이전 사례에 sources.json·workplan.json 이 없습니다 — ${dir} (이전 사례가 끝까지 통과해야 계보로 이을 수 있습니다)`);
  const reg = JSON.parse(readFileSync(regPath, 'utf8'));
  return { case: previous.case, caseId: reg.caseId, sourcesDigest: reg.digest, workplanDigest: sha256(canonical(JSON.parse(readFileSync(planPath, 'utf8')))), supersedes: previous.supersedes ?? {} };
}

export function register(caseDir) {
  const inputsPath = join(caseDir, 'inputs.json');
  if (!existsSync(inputsPath)) fail(`inputs.json 이 없습니다 — ${inputsPath}`);
  const { caseId, inputs, previous, brief } = JSON.parse(readFileSync(inputsPath, 'utf8'));
  if (!caseId || !Array.isArray(inputs) || inputs.length === 0) fail('inputs.json 에 caseId 와 inputs[] 가 필요합니다');

  const ids = new Set();
  const sources = inputs.map((input) => {
    if (!input.id || ids.has(input.id)) fail(`id 가 비었거나 중복입니다 — ${input.id}`);
    ids.add(input.id);
    if (!KINDS.has(input.kind)) fail(`${input.id}: kind 는 ${[...KINDS].join('|')} 중 하나`);
    if (!ROLES.has(input.role)) fail(`${input.id}: role 은 ${[...ROLES].join('|')} 중 하나`);
    const body = input.kind === 'code' ? describeCode(input) : describeFile(input);
    return { id: input.id, kind: input.kind, role: input.role, note: input.note ?? null, ...body };
  }).sort((a, b) => a.id.localeCompare(b.id));

  const doc = { schemaVersion: 1, kind: 'SourceRegistry', caseId, sources };
  if (brief) doc.brief = String(brief);
  if (previous) doc.lineage = describePrevious(caseDir, previous);
  doc.digest = sha256(canonical(doc));
  writeFileSync(join(caseDir, 'sources.json'), `${JSON.stringify(doc, null, 2)}\n`);
  return doc;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) fail('usage: node scripts/register.mjs <case-dir>');
  const doc = register(resolve(dir));
  for (const s of doc.sources) process.stdout.write(`${s.id}\t${s.kind}\t${s.sha256.slice(0, 12)}\n`);
  process.stdout.write(`digest\t${doc.digest.slice(0, 12)}\n`);
}
