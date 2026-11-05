#!/usr/bin/env node
// S2 extract — sources.json 의 원본마다 위치를 가리킬 수 있는 앵커 목록을 extract/<id>.json 으로 낸다.
// 앵커는 S3·S4 판단의 입력이자 workplan 의 sourceRefs.locator 가 된다. 해석은 하지 않는다.
// usage: node scripts/extract.mjs <case-dir>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonical, sha256 } from './register.mjs';

const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const squash = (s) => s.replace(/\s+/g, ' ').trim();
const ENTITIES = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&' };
const unescapeXml = (s) => s.replace(/&(lt|gt|quot|apos|amp);/g, (m) => ENTITIES[m]);

function htmlAnchors(text) {
  const anchors = [];
  const push = (type, value, index) => anchors.push({ type, value: squash(value).slice(0, 160), line: lineOf(text, index) });
  for (const m of text.matchAll(/<title>([^<]*)<\/title>/g)) push('title', m[1], m.index);
  for (const m of text.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/g)) {
    const label = m[2].replace(/<[^>]+>/g, '');
    if (squash(label)) push(`h${m[1]}`, label, m.index);
  }
  for (const m of text.matchAll(/\bid="([^"]+)"/g)) push('id', m[1], m.index);
  for (const m of text.matchAll(/\bdata-(panel|screen|tab|conn-refresh)="([^"]*)"/g)) push(`data-${m[1]}`, m[2], m.index);
  for (const m of text.matchAll(/SCREENS\[['"]([^'"]+)['"]\]/g)) push('screen-key', m[1], m.index);
  for (const m of text.matchAll(/\/\*\s*[-=─]{2,}\s*([^*]+?)\s*[-=─]*\s*\*\//g)) push('comment-marker', m[1], m.index);
  for (const m of text.matchAll(/<!--\s*([\s\S]*?)\s*-->/g)) if (squash(m[1]).length > 2) push('comment', m[1], m.index);
  return anchors;
}

function jsAnchors(text) {
  const anchors = htmlAnchors(text).filter((a) => a.type.startsWith('comment') || a.type.startsWith('data-'));
  for (const m of text.matchAll(/(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/g)) {
    anchors.push({ type: 'function', value: m[1] ?? m[2], line: lineOf(text, m.index) });
  }
  return anchors;
}

// docx: 문단 스타일 1·2·3 을 제목 단계로 보고 절 경로를 만든다. 표는 행 단위 텍스트로 남긴다.
function docxAnchors(path) {
  const xml = execFileSync('unzip', ['-p', path, 'word/document.xml'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const text = (frag) => squash(unescapeXml((frag.match(/<w:t[^>]*>[^<]*<\/w:t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join('')));
  const anchors = [];
  const trail = [];
  const body = xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, (tbl) => {
    const rows = (tbl.match(/<w:tr[\s\S]*?<\/w:tr>/g) ?? []).map((tr) => (tr.match(/<w:tc>[\s\S]*?<\/w:tc>/g) ?? []).map(text));
    return `<w:p><kh-table>${Buffer.from(JSON.stringify(rows)).toString('base64')}</kh-table></w:p>`;
  });
  let order = 0;
  for (const p of body.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []) {
    order += 1;
    const table = p.match(/<kh-table>([^<]+)<\/kh-table>/);
    if (table) {
      anchors.push({ type: 'table', section: trail.join(' > '), order, rows: JSON.parse(Buffer.from(table[1], 'base64').toString()) });
      continue;
    }
    const value = text(p);
    if (!value) continue;
    const level = Number(p.match(/<w:pStyle w:val="([123])"\/>/)?.[1] ?? 0);
    if (level) {
      trail.length = level - 1;
      trail[level - 1] = value;
      anchors.push({ type: `heading${level}`, value, section: trail.join(' > '), order });
    } else {
      anchors.push({ type: 'paragraph', value, section: trail.join(' > '), order });
    }
  }
  return anchors;
}

// OpenAPI: JSON 이면 그대로 읽고, YAML 이면 의존성 없이 paths 아래 경로·메서드·operationId 만 들여쓰기로 읽는다.
function openapiAnchors(text) {
  let spec = null;
  // 주석 머리말 + JSON 본문(YAML 상위집합)도 JSON 으로 읽는다.
  try { spec = JSON.parse(text.replace(/^(\s*#.*\n)+/, '')); } catch { /* YAML */ }
  if (spec?.paths) {
    return Object.entries(spec.paths).flatMap(([path, item]) => Object.entries(item)
      .filter(([method, op]) => /^(get|put|post|patch|delete)$/.test(method) && op?.operationId)
      .map(([method, op]) => ({ type: 'operation', value: op.operationId, method: method.toUpperCase(), path, summary: op.summary ?? null })))
      .sort((a, b) => a.value.localeCompare(b.value));
  }
  const anchors = [];
  let inPaths = false;
  let path = null;
  let method = null;
  text.split('\n').forEach((raw, i) => {
    if (/^paths:\s*$/.test(raw)) { inPaths = true; return; }
    if (/^\S/.test(raw)) { inPaths = false; }
    if (!inPaths) return;
    const p = raw.match(/^ {2}(['"]?)(\/[^'":]*)\1:\s*$/);
    if (p) { path = p[2]; method = null; return; }
    const m = raw.match(/^ {4}(get|put|post|patch|delete):\s*$/);
    if (m) { method = m[1].toUpperCase(); return; }
    const op = raw.match(/^ {6}operationId:\s*['"]?([\w-]+)/);
    if (op && path && method) anchors.push({ type: 'operation', value: op[1], method, path, line: i + 1 });
  });
  return anchors;
}

function codeAnchors(source) {
  const files = execFileSync('git', ['-C', source.repo, 'ls-tree', '-r', '--name-only', source.commit, '--', ...source.paths], { encoding: 'utf8' })
    .split('\n').filter(Boolean);
  const anchors = files.map((file) => ({ type: 'file', value: file }));
  for (const file of files.filter((f) => /\.(tsx?|jsx?)$/.test(f) && !/\.(test|stories)\./.test(f))) {
    const text = execFileSync('git', ['-C', source.repo, 'show', `${source.commit}:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    for (const m of text.matchAll(/export\s+(?:default\s+)?(?:function|const|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g)) {
      anchors.push({ type: 'export', value: m[1], file, line: lineOf(text, m.index) });
    }
    // 이름 목록 재내보내기: export { A, B as C } from './x' — 바깥에 보이는 이름(C)을 남긴다.
    for (const m of text.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
      for (const part of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
        const name = part.replace(/^type\s+/, '').split(/\s+as\s+/).pop().trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name) && name !== 'default') anchors.push({ type: 'export', value: name, file, line: lineOf(text, m.index) });
      }
    }
  }
  return anchors;
}

// 짝이 맞는 닫는 중괄호 다음 위치를 돌려준다(start 는 여는 중괄호 바로 다음). 문자열 안의 괄호는 건너뛴다.
function closeOf(text, start) {
  let depth = 1; let quote = null; let i = start;
  for (; i < text.length && depth > 0; i += 1) {
    const c = text[i];
    if (quote) { if (c === '\\') i += 1; else if (c === quote) quote = null; } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{' || c === '(' || c === '[') depth += 1; else if (c === '}' || c === ')' || c === ']') depth -= 1;
  }
  return i;
}

// 객체 본문을 최상위 `key: value` 로 쪼갠다. 값은 원문 그대로다.
function topEntries(body) {
  const entries = []; let depth = 0; let quote = null; let from = 0;
  const push = (end) => {
    const seg = body.slice(from, end); const at = seg.indexOf(':');
    if (at > 0) entries.push([seg.slice(0, at).trim().replace(/^(['"])(.*)\1$/, '$2'), seg.slice(at + 1).trim()]);
    from = end + 1;
  };
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (quote) { if (c === '\\') i += 1; else if (c === quote) quote = null; } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if ('{(['.includes(c)) depth += 1; else if ('})]'.includes(c)) depth -= 1;
    else if (c === ',' && depth === 0) push(i);
  }
  push(body.length);
  return entries;
}

const objectBody = (value) => (value.startsWith('{') ? value.slice(1, value.lastIndexOf('}')) : null);
const literal = (v) => v.match(/^(['"`])(.*)\1$/)?.[2];

// class-variance-authority(cva)·tailwind-variants(tv) 의 `variants: { 축: { 값: 클래스 } }` 에서 축 이름과 값 목록을, defaultVariants 에서 기본값을 읽는다.
function variantAnchors(text, file) {
  const calls = [...text.matchAll(/(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:cva|tv)\s*\(/g)];
  const anchors = [];
  calls.forEach((m, n) => {
    const chunk = text.slice(m.index, calls[n + 1]?.index ?? text.length);
    const v = chunk.match(/\bvariants\s*:\s*\{/);
    if (!v) return;
    const start = v.index + v[0].length;
    const axes = Object.fromEntries(topEntries(chunk.slice(start, closeOf(chunk, start) - 1))
      .map(([axis, value]) => [axis, topEntries(objectBody(value) ?? '').map(([name]) => name)]).filter(([, names]) => names.length));
    if (!Object.keys(axes).length) return;
    const d = chunk.match(/\bdefaultVariants\s*:\s*\{/);
    const defaults = d ? Object.fromEntries(topEntries(chunk.slice(d.index + d[0].length, closeOf(chunk, d.index + d[0].length) - 1)).map(([k, val]) => [k, literal(val) ?? val]).filter(([, val]) => val)) : {};
    anchors.push({ type: 'variants', value: m[1], file, line: lineOf(text, m.index), variants: axes, ...(Object.keys(defaults).length ? { defaults } : {}) });
  });
  return anchors;
}

// 디자인 시스템: export 앵커에 더해 컴포넌트 인덱스를 남긴다 — 에이전트는 수백 파일을 다 열지 않고
// 이 인덱스로 후보 부품을 고른 뒤 그 파일만 연다.
//   props     `export interface XxxProps { a?: T; b: U }` · `export type XxxProps = { ... }` 의 1단계 필드 이름과,
//             한 줄 문자열 리터럴 유니온(`variant?: 'a' | 'b'`)이면 그 값(values). 타입 해석은 하지 않는다.
//   variants  cva·tv 로 정의한 스타일 변형의 축(variant·size …)과 값, 기본값.
function designSystemAnchors(source) {
  const anchors = codeAnchors(source);
  const files = anchors.filter((a) => a.type === 'file').map((a) => a.value)
    .filter((f) => /\.(tsx?)$/.test(f) && !/\.(test|stories|spec)\./.test(f) && !/\.d\.ts$/.test(f));
  for (const file of files) {
    const text = execFileSync('git', ['-C', source.repo, 'show', `${source.commit}:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    for (const m of text.matchAll(/export\s+(?:interface|type)\s+([A-Za-z_$][\w$]*Props)\b[^{]*\{/g)) {
      const start = m.index + m[0].length;
      const body = text.slice(start, closeOf(text, start) - 1);
      const fields = [...body.matchAll(/^\s{2}(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:(.*)$/gm)];
      const values = Object.fromEntries(fields.map((p) => [p[1], p[2].trim().replace(/;$/, '')])
        .filter(([, t]) => /^(?:'[^']*'|"[^"]*")(?:\s*\|\s*(?:'[^']*'|"[^"]*"))*$/.test(t))
        .map(([k, t]) => [k, [...t.matchAll(/['"]([^'"]*)['"]/g)].map((x) => x[1])]));
      if (fields.length) anchors.push({ type: 'props', value: m[1], file, line: lineOf(text, m.index), props: fields.map((p) => p[1]), ...(Object.keys(values).length ? { values } : {}) });
    }
    anchors.push(...variantAnchors(text, file));
  }
  return anchors;
}

// Markdown: 제목을 절 경로로, 표 행과 목록 항목을 앵커로 남긴다.
function markdownAnchors(text) {
  const anchors = [];
  const trail = [];
  text.split('\n').forEach((raw, i) => {
    const h = raw.match(/^(#{1,4})\s+(.*)$/);
    if (h) { trail.length = h[1].length - 1; trail[h[1].length - 1] = h[2].trim(); anchors.push({ type: `heading${h[1].length}`, value: h[2].trim(), section: trail.join(' > '), line: i + 1 }); return; }
    if (/^\s*(\||[-*] |\d+\. )/.test(raw) && squash(raw).length > 3) anchors.push({ type: raw.trim().startsWith('|') ? 'table-row' : 'item', value: squash(raw).slice(0, 200), section: trail.join(' > '), line: i + 1 });
  });
  return anchors;
}

function extractOne(source) {
  if (source.kind === 'plan-doc') return docxAnchors(source.path);
  if (source.kind === 'context-doc') return markdownAnchors(readFileSync(source.path, 'utf8'));
  if (source.kind === 'code' && source.role === 'contract') {
    const [file] = source.paths;
    return openapiAnchors(execFileSync('git', ['-C', source.repo, 'show', `${source.commit}:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  }
  if (source.kind === 'code' && source.role === 'design-system') return designSystemAnchors(source);
  if (source.kind === 'code') return codeAnchors(source);
  if (source.kind === 'api-contract') return openapiAnchors(readFileSync(source.path, 'utf8')); // 레포 없이 파일로 들어온 API 스펙
  const text = readFileSync(source.path, 'utf8');
  return source.kind === 'design-asset' ? jsAnchors(text) : htmlAnchors(text);
}

export function extract(caseDir) {
  const registry = JSON.parse(readFileSync(join(caseDir, 'sources.json'), 'utf8'));
  const outDir = join(caseDir, 'extract');
  mkdirSync(outDir, { recursive: true });
  return registry.sources.map((source) => {
    const anchors = extractOne(source);
    const doc = { schemaVersion: 1, kind: 'SourceAnchors', sourceId: source.id, inputDigest: source.sha256, anchors };
    doc.digest = sha256(canonical(doc));
    writeFileSync(join(outDir, `${source.id}.json`), `${JSON.stringify(doc, null, 2)}\n`);
    return { id: source.id, anchors: anchors.length, digest: doc.digest };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) { process.stderr.write('usage: node scripts/extract.mjs <case-dir>\n'); process.exit(2); }
  for (const r of extract(resolve(dir))) process.stdout.write(`${r.id}\t${r.anchors}\t${r.digest.slice(0, 12)}\n`);
}
