import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonical, sha256 } from '../register.mjs';

export const BLOCKING = new Set(['gap', 'ds-override', 'token-missing', 'behavior-mismatch']);
export const PRINCIPLE = '컴포넌트 규칙을 시안의 px보다 우선한다. 1. 올바른 size/variant/prop을 쓴다. 2. 기존 컴포넌트를 조합한다. 3. 반복 UI이면 새 컴포넌트 후보와 근거를 판단한다. 4. 임의 px className 덮어쓰기는 새 갭이다. 측정값은 증거이며 size의 근거는 클래스다.';
const norm = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
const identity = (e) => `${norm(e.text)}|${e.label ?? ''}|${e.attributes?.placeholder ?? ''}|${e.attributes?.type ?? ''}`;
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
      comparisons: [difference('kind', d.kind, e.kind), difference('tag', d.tag, e.tag), difference('reference', d.reference, e.reference), ...['x', 'y', 'width', 'height'].map(p => difference(`rect.${p}`, d.rect[p], e.rect[p], ['x', 'y'].includes(p) ? tolerance.position : tolerance.size)),
        ...Object.entries(d.style).map(([p, value]) => difference(`style.${p}`, value, e.style[p], /^(padding|margin|gap)/.test(p) ? tolerance.spacing : tolerance.size))] }));
    return { id: `F-${design.sourceId}-${d.id}`, kind: 'element-observation', sourceId: design.sourceId, element: d.id, candidates };
  });
  const interactions = design.interactions.map(d => ({ id: `F-${design.sourceId}-${d.id}`, kind: 'interaction-observation', sourceId: design.sourceId, element: d.id, observed: d,
    candidates: implementation.interactions.filter(i => i.kind === d.kind).map(i => ({ implementation: i.id, observed: i, labelsEqual: canonical(d.items.map(x => norm(x.label))) === canonical(i.items.map(x => norm(x.label))), comparisons: ['openPolicy', 'reclick', 'initial'].map(p => difference(p, d[p], i[p])) })) }));
  return [...elements, ...interactions];
}

const EXCLUDED = ['.git', 'node_modules', '.local', 'dist', 'build', '.next'];
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(e => e.isSymbolicLink() || EXCLUDED.includes(e.name) ? [] : e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);

// JSX 속성의 문자열·중첩 표현식은 태그 끝으로 처리하지 않는다.
function enclosedEnd(text, start) {
  const open = text[start]; const close = open === '{' ? '}' : open;
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === close) return i + 1;
    if (open !== '{') continue;
    if (text.startsWith('//', i)) { const end = text.indexOf('\n', i); i = end < 0 ? text.length : end; }
    else if (text.startsWith('/*', i)) { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 1; }
    else if (['{', '"', "'", '`'].includes(text[i])) i = enclosedEnd(text, i) - 1;
  }
  return text.length;
}

function jsxClasses(text) {
  const found = [];
  for (const m of text.matchAll(/<([A-Z][\w.]*)\b/g)) {
    let attribute = null; let end = m.index + m[0].length;
    for (; end < text.length && text[end] !== '>'; end++) {
      const attr = text.slice(end).match(/^className\s*=\s*/);
      if (attr && /\s/.test(text[end - 1])) {
        const start = end + attr[0].length;
        const stop = enclosedEnd(text, start);
        const raw = text.slice(start, stop);
        const literals = raw.startsWith('{') ? [...raw.matchAll(/"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`/g)].map(x => x[1] ?? x[2] ?? x[3]).filter(x => !x.includes('${')) : [raw.slice(1, -1)];
        attribute = { className: raw, classes: literals.flatMap(x => x.split(/\s+/).filter(Boolean)) };
        end = stop - 1;
      } else if (['{', '"', "'", '`'].includes(text[end])) end = enclosedEnd(text, end) - 1;
    }
    if (attribute) found.push({ component: m[1], index: m.index, snippet: text.slice(m.index, end + 1), ...attribute });
  }
  return found;
}

export function inspectCode(codeDir, specs) {
  codeDir = resolve(codeDir);
  if (!existsSync(codeDir)) throw new Error(`코드 경로가 없음: ${codeDir}`);
  let root = codeDir; let files; let listing = 'filesystem';
  try {
    root = execFileSync('git', ['-C', codeDir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    files = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split('\0').filter(Boolean).map(p => join(root, p)).filter(p => existsSync(p));
    listing = 'git-tracked-and-nonignored';
  } catch { files = walk(root); }
  const definitions = new Map(); const candidates = []; const overrides = []; const digests = [];
  const searched = { root, extensions: ['.css'], excluded: listing === 'filesystem' ? [...EXCLUDED, 'symbolic-links'] : ['git-ignored files unless tracked', 'untracked package files'], listing };
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
    for (const m of jsxClasses(text)) {
      const line = text.slice(0, m.index).split('\n').length;
      candidates.push({ component: m.component, file: path, line, className: m.className, classes: m.classes, snippet: m.snippet, reason: 'JSX 컴포넌트의 className 사용례. 적합성 판단 필요' });
      const rel = relative(codeDir, file); if (rel.startsWith('..') || resolve(codeDir, rel) !== file) continue;
      overrides.push({ kind: 'jsx-classname', property: 'className', component: m.component, file: path, line, expected: null, actual: { className: m.className, classes: m.classes }, evidence: `${path}:${line}`, snippet: m.snippet, observation: 'JSX 컴포넌트에 전달된 className 원문과 정적 문자열 클래스. 동적 표현식은 평가하지 않음', candidates: [] });
    }
  }
  const missing = [];
  const seen = new Set();
  for (const spec of specs) for (const e of spec.elements) for (const token of e.tokens ?? []) {
    const key = `${spec.sourceId}|${token.name}`;
    if (definitions.has(token.name) || seen.has(key)) continue;
    seen.add(key);
    missing.push({ kind: 'token-undefined', sourceId: spec.sourceId, designDigest: spec.digest, element: e.id, property: token.name, expected: { token: token.name, value: token.value, definitions: token.definitions, classes: e.classes.filter(c => c.includes(token.name)) }, actual: null, searched, evidence: `${spec.sourceId}:${e.id}`, componentHint: null, observation: '검색 범위 안에서 선언을 찾지 못함', candidates: candidates.map(({ component, file, line }) => ({ component, file, line })) });
  }
  for (const o of overrides) o.candidates = candidates.filter(c => c.component === o.component && `${c.file}:${c.line}` !== o.evidence).map(({ component, file, line }) => ({ component, file, line }));
  return { facts: [...overrides, ...missing].map((f, i) => ({ id: `F-CODE-${i + 1}`, ...f })), definitions: Object.fromEntries([...definitions].sort()), existingPatterns: candidates, codeDigest: sha256(canonical(digests)), files: digests.length };
}

export const VERDICTS = ['match', 'acceptable', 'gap', 'ds-override', 'token-missing', 'needs-component', 'behavior-mismatch'];
export function judgmentErrors(draft, facts) {
  const errors = [];
  if (!draft || !Array.isArray(draft.rows)) return ['판정 rows 배열이 필요함'];
  if (draft.factsDigest !== facts.digest) errors.push('factsDigest가 현재 사실 수집 결과와 다름');
  const known = new Set(facts.facts.map(f => f.id));
  const covered = new Set(); const ids = new Set();
  const evidenceIds = new Set([...known, ...facts.implementation.elements.map(e => e.id), ...facts.implementation.interactions.map(e => e.id), ...facts.baseline.samples.map(b => b.id), ...facts.code.existingPatterns.map(c => `${c.file}:${c.line}`), ...Object.values(facts.code.tokenDefinitions).flat().map(c => `${c.file}:${c.line}`)]);
  for (const r of draft.rows) {
    if (!r || typeof r !== 'object') { errors.push('판정 행은 객체여야 함'); continue; }
    const factIds = Array.isArray(r.factIds) ? r.factIds : [];
    const observations = Array.isArray(r.observations) ? r.observations : [];
    const evidence = Array.isArray(r.evidence) ? r.evidence : [];
    if (!r.id || ids.has(r.id)) errors.push('판정 id가 없거나 중복됨'); ids.add(r.id);
    if (!VERDICTS.includes(r.verdict) || !r.reason) errors.push(`${r.id}: 판정과 이유가 필요함`);
    if (!Array.isArray(r.factIds) || !r.factIds.length) errors.push(`${r.id}: factIds가 필요함`);
    for (const id of factIds) { if (!known.has(id)) errors.push(`${r.id}: 실재하지 않는 사실 ${id}`); if (covered.has(id)) errors.push(`${id}: 중복 판정`); covered.add(id); }
    if (!Array.isArray(r.observations) || r.observations.length !== r.factIds?.length) errors.push(`${r.id}: factIds마다 observations의 fact/implementation 쌍이 필요함`);
    const selected = new Set();
    for (const pair of observations) {
      if (!pair || typeof pair !== 'object') { errors.push(`${r.id}: observations 쌍이 필요함`); continue; }
      const fact = facts.facts.find(f => f.id === pair.fact);
      if (!factIds.includes(pair.fact) || selected.has(pair.fact)) errors.push(`${r.id}: observations의 사실이 없거나 중복됨`);
      selected.add(pair.fact);
      if (pair.implementation !== null && (typeof pair.implementation !== 'string' || !fact?.candidates?.some(c => c.implementation === pair.implementation))) errors.push(`${r.id}: 해당 사실의 구현 후보 id 또는 null이 필요함`);
    }
    if (!Array.isArray(r.evidence) || !r.evidence.length || r.evidence.some(id => !evidenceIds.has(id))) errors.push(`${r.id}: 실재하는 근거 id가 필요함`);
    if (r.verdict === 'acceptable' && !evidence.some(id => facts.baseline.samples.some(b => b.id === id) || facts.code.existingPatterns.some(c => `${c.file}:${c.line}` === id))) errors.push(`${r.id}: acceptable은 컴포넌트 기준 또는 코드 사용례 근거가 필요함`);
    if (r.componentHint) {
      const classes = new Set(facts.designs.flatMap(d => d.elements.filter(e => factIds.includes(`F-${d.sourceId}-${e.id}`)).flatMap(e => e.classes)).concat(facts.baseline.samples.filter(b => evidence.includes(b.id)).flatMap(b => b.classes)));
      if (!Array.isArray(r.componentHint.classes) || !r.componentHint.classes.length || r.componentHint.classes.some(c => !classes.has(c))) errors.push(`${r.id}: componentHint에는 실재하는 근거 클래스가 필요함`);
    }
    if (r.verdict === 'behavior-mismatch' && r.question?.to !== 'design') errors.push(`${r.id}: behavior-mismatch는 to:design 확인 질문이 필요함`);
  }
  for (const id of known) if (!covered.has(id)) errors.push(`판정 누락: ${id}`);
  return errors;
}

export function groundJudgments(draft, facts) {
  return { ...draft, rows: draft.rows.map(row => {
    const expected = []; const actual = [];
    for (const pair of row.observations) {
      const fact = facts.facts.find(f => f.id === pair.fact);
      const candidate = fact.candidates?.find(c => c.implementation === pair.implementation);
      const design = facts.designs.find(d => d.sourceId === fact.sourceId)?.elements.find(e => e.id === fact.element);
      const values = (side) => candidate ? Object.fromEntries(candidate.comparisons.map(c => [c.property, c[side]])) : side === 'expected' ? fact.expected ?? fact.observed ?? design ?? null : fact.actual ?? null;
      expected.push({ ...pair, values: values('expected') });
      actual.push({ ...pair, values: values('actual') });
    }
    return { ...row, expected, actual };
  }) };
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
