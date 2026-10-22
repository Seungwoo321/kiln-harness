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
