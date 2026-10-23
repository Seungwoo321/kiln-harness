import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonical, sha256 } from '../register.mjs';

export const BLOCKING = new Set(['gap', 'ds-override', 'token-missing', 'behavior-mismatch']);
export const PRINCIPLE = '컴포넌트 규칙을 시안의 px보다 우선한다. 1. 올바른 size/variant/prop을 쓴다. 2. 기존 컴포넌트를 조합한다. 3. 반복 UI이면 새 컴포넌트 후보와 근거를 판단한다. 4. 임의 px className 덮어쓰기는 새 갭이다. 측정값은 증거이며 size의 근거는 클래스다.';
const norm = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
const identity = (e) => `${e.kind}|${norm(e.text)}|${e.label ?? ''}|${e.attributes?.placeholder ?? ''}|${e.attributes?.type ?? ''}`;
const numeric = (x) => typeof x === 'number' ? x : /^-?\d+(?:\.\d+)?px$/.test(x) ? parseFloat(x) : null;

// 후보와 차이만 계산한다. 후보 선택·수용 여부는 판정 단계가 소유한다.
export function compareFacts(design, implementation, tolerances = {}) {
  const tolerance = { position: 1, size: 1, spacing: 2, ...tolerances };
  for (const [key, value] of Object.entries(tolerance)) if (!['position', 'size', 'spacing'].includes(key) || !Number.isFinite(value) || value < 0) throw new Error(`잘못된 허용 오차: ${key}`);
  const difference = (property, expected, actual, limit) => {
    const a = numeric(expected); const b = numeric(actual);
    return { property, expected, actual, equal: canonical(expected) === canonical(actual), ...(a !== null && b !== null ? { delta: Math.round((b - a) * 100) / 100, tolerance: limit, withinTolerance: Math.abs(b - a) <= limit } : {}) };
  };
  const elements = design.elements.map(d => {
    const candidates = implementation.elements.filter(e => identity(e) === identity(d)).map(e => ({ implementation: e.id,
      comparisons: [difference('reference', d.reference, e.reference), ...['x', 'y', 'width', 'height'].map(p => difference(`rect.${p}`, d.rect[p], e.rect[p], ['x', 'y'].includes(p) ? tolerance.position : tolerance.size)),
        ...Object.entries(d.style).map(([p, value]) => difference(`style.${p}`, value, e.style[p], /^(padding|margin|gap)/.test(p) ? tolerance.spacing : tolerance.size))] }));
    return { id: `F-${design.sourceId}-${d.id}`, kind: 'element-observation', sourceId: design.sourceId, element: d.id, candidates };
  });
  const interactions = design.interactions.map(d => ({ id: `F-${design.sourceId}-${d.id}`, kind: 'interaction-observation', sourceId: design.sourceId, element: d.id, observed: d,
    candidates: implementation.interactions.filter(i => i.kind === d.kind).map(i => ({ implementation: i.id, observed: i, labelsEqual: canonical(d.items.map(x => norm(x.label))) === canonical(i.items.map(x => norm(x.label))), comparisons: ['openPolicy', 'reclick', 'initial'].map(p => difference(p, d[p], i[p])) })) }));
  return [...elements, ...interactions];
}

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(e => e.isSymbolicLink() || ['.git', 'node_modules', '.local', 'dist', 'build', '.next'].includes(e.name) ? [] : e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
export function inspectCode(codeDir, specs, baseline) {
  codeDir = resolve(codeDir);
  if (!existsSync(codeDir)) throw new Error(`코드 경로가 없음: ${codeDir}`);
  let root = codeDir; let files;
  try {
    root = execFileSync('git', ['-C', codeDir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    files = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split('\0').filter(Boolean).map(p => join(root, p)).filter(p => existsSync(p));
  } catch { files = walk(root); }
  const definitions = new Map(); const candidates = []; const overrides = []; const digests = [];
  const components = [...new Set(['Badge', 'Button', 'Input', ...baseline.samples.map(b => b.componentLabel.replace(/(^|-)([a-z])/g, (_, a, b) => b.toUpperCase()))])];
  for (const file of files.filter(p => /\.(?:css|[jt]sx)$/.test(p)).sort()) {
    const text = readFileSync(file, 'utf8'); const path = relative(root, file).split('\\').join('/');
    digests.push({ file: path, digest: sha256(text) });
    if (/\.css$/.test(file)) {
      const clean = text.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
      for (const m of clean.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)/g)) {
        const list = definitions.get(m[1]) ?? [];
        list.push({ file: path, line: text.slice(0, m.index).split('\n').length, value: m[2].trim() }); definitions.set(m[1], list);
      }
      continue;
    }
    const tag = new RegExp(`<(${components.join('|')})(?=[\\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>`, 'g');
    for (const m of text.matchAll(tag)) {
      const line = text.slice(0, m.index).split('\n').length;
      if (/className\s*=/.test(m[0])) candidates.push({ component: m[1], file: path, line, snippet: m[0].slice(0, 500), reason: '같은 종류 컴포넌트에 className을 전달하는 기존 사용례. 적합성 판단 필요' });
      const rel = relative(codeDir, file); if (rel.startsWith('..') || resolve(codeDir, rel) !== file) continue;
      const classPart = m[0].match(/className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([\s\S]*?)\})/);
      if (!classPart) continue;
      const tokens = (classPart[1] ?? classPart[2] ?? classPart[3]).match(/(?:^|[\s'"`])((?:[\w-]+:)*!?(?:w-\d[\w./-]*|h-\[[^\]]+\]|px-0|min-w-[^\s'"`}]+))/g)?.map(x => x.trim().replace(/^['"`]/, '')) ?? [];
      if (tokens.length) overrides.push({ kind: 'px-classes-present', property: 'className', component: m[1], file: path, line, expected: '컴포넌트 size/variant/prop 또는 토큰', actual: tokens, evidence: `${path}:${line}`, snippet: m[0], observation: 'DS 컴포넌트 JSX의 className에 크기 유틸리티가 존재함', candidates: [] });
    }
  }
  const missing = [];
  const seen = new Set();
  for (const spec of specs) for (const e of spec.elements) for (const token of e.tokens ?? []) {
    const key = `${spec.sourceId}|${token.name}`;
    if (definitions.has(token.name) || seen.has(key)) continue;
    seen.add(key);
    missing.push({ kind: 'token-undefined', sourceId: spec.sourceId, designDigest: spec.digest, element: e.id, property: token.name, expected: { token: token.name, value: token.value, definitions: token.definitions, classes: e.classes.filter(c => c.includes(token.name)) }, actual: null, evidence: `${spec.sourceId}:${e.id}`, componentHint: null, observation: '시안 클래스가 참조하는 토큰의 구현 CSS 선언이 없음', candidates: candidates.filter(c => c.component.toLowerCase() === (e.componentHint?.component ?? e.componentName ?? e.kind)).slice(0, 12) });
  }
  for (const o of overrides) o.candidates = candidates.filter(c => c.component === o.component && `${c.file}:${c.line}` !== o.evidence).slice(0, 8);
  return { facts: [...overrides, ...missing].map((f, i) => ({ id: `F-CODE-${i + 1}`, ...f })), definitions: Object.fromEntries([...definitions].sort()), existingPatterns: candidates, codeDigest: sha256(canonical(digests)), files: digests.length };
}

export const VERDICTS = ['match', 'acceptable', 'gap', 'ds-override', 'token-missing', 'needs-component', 'behavior-mismatch'];
export function judgmentErrors(draft, facts) {
  const errors = [];
  if (!draft || !Array.isArray(draft.rows)) return ['판정 rows 배열이 필요함'];
  if (draft.factsDigest !== facts.digest) errors.push('factsDigest가 현재 사실 수집 결과와 다름');
  const known = new Set(facts.facts.map(f => f.id));
  const covered = new Set(); const ids = new Set();
  const evidenceIds = new Set([...known, ...facts.baseline.samples.map(b => b.id), ...facts.code.existingPatterns.map(c => `${c.file}:${c.line}`), ...Object.values(facts.code.tokenDefinitions).flat().map(c => `${c.file}:${c.line}`)]);
  for (const r of draft.rows) {
    if (!r.id || ids.has(r.id)) errors.push('판정 id가 없거나 중복됨'); ids.add(r.id);
    if (!VERDICTS.includes(r.verdict) || !r.reason) errors.push(`${r.id}: 판정과 이유가 필요함`);
    if (!Array.isArray(r.factIds) || !r.factIds.length) errors.push(`${r.id}: factIds가 필요함`);
    for (const id of r.factIds ?? []) { if (!known.has(id)) errors.push(`${r.id}: 실재하지 않는 사실 ${id}`); if (covered.has(id)) errors.push(`${id}: 중복 판정`); covered.add(id); }
    if (!Array.isArray(r.evidence) || !r.evidence.length || r.evidence.some(id => !evidenceIds.has(id))) errors.push(`${r.id}: 실재하는 근거 id가 필요함`);
    if (r.verdict === 'acceptable' && !(r.evidence ?? []).some(id => facts.baseline.samples.some(b => b.id === id) || facts.code.existingPatterns.some(c => `${c.file}:${c.line}` === id))) errors.push(`${r.id}: acceptable은 컴포넌트 기준 또는 코드 사용례 근거가 필요함`);
    if (r.componentHint) {
      const classes = new Set(facts.designs.flatMap(d => d.elements.filter(e => (r.factIds ?? []).includes(`F-${d.sourceId}-${e.id}`)).flatMap(e => e.classes)).concat(facts.baseline.samples.filter(b => (r.evidence ?? []).includes(b.id)).flatMap(b => b.classes)));
      if (!Array.isArray(r.componentHint.classes) || !r.componentHint.classes.length || r.componentHint.classes.some(c => !classes.has(c))) errors.push(`${r.id}: componentHint에는 실재하는 근거 클래스가 필요함`);
    }
    if (r.verdict === 'behavior-mismatch' && r.question?.to !== 'design') errors.push(`${r.id}: behavior-mismatch는 to:design 확인 질문이 필요함`);
  }
  for (const id of known) if (!covered.has(id)) errors.push(`판정 누락: ${id}`);
  return errors;
}

export function conformanceBrief(report) {
  const out = ['# 시안 적합성 구현 지시서', '', PRINCIPLE, '', `상태: ${report.status}. 사실 digest: ${report.factsDigest ?? ''}. 판정 digest: ${report.digest}.`, ''];
  if (report.reason) out.push(report.reason, '');
  for (const row of report.rows.filter(r => r.verdict !== 'match')) {
    out.push(`## ${row.id} — ${row.verdict}`, '', `사실: ${(row.factIds ?? []).join(', ')}`, `근거: ${(row.evidence ?? []).join(', ')}`, `시안: ${JSON.stringify(row.expected ?? null)}`, `구현: ${JSON.stringify(row.actual ?? null)}`, `판정 이유: ${row.reason}`, `컴포넌트: ${JSON.stringify(row.componentHint ?? null)}`);
    if (row.question) out.push(`확인 질문: ${JSON.stringify(row.question)}`);
    for (const fact of (report.facts ?? []).filter(f => (row.factIds ?? []).includes(f.id))) out.push(`수집 사실: ${JSON.stringify(fact)}`);
    out.push('');
  }
  return `${out.join('\n')}\n`;
}
