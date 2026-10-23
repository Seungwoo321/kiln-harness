#!/usr/bin/env node
// S2d — 렌더 사실·컴포넌트 기준·기존 코드 사용례를 수집한다.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname, relative, basename, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonical, sha256 } from './register.mjs';
import { findChrome, launchBrowser, navigate, serve, serveGit } from './lib/browser.mjs';
import { snapshotDOM } from './lib/dom-snapshot.mjs';

export const seal = (doc) => { const body = JSON.parse(JSON.stringify(doc)); return { ...body, digest: sha256(canonical(body)) }; };
export const writeJson = (path, doc) => writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const ENGINE = sha256(['design-spec.mjs', 'lib/browser.mjs', 'lib/dom-snapshot.mjs'].map(p => readFileSync(new URL(p, import.meta.url))).join('\n'));
const filesUnder = (root) => readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(e => e.isSymbolicLink() || ['.git', 'node_modules', '.local'].includes(e.name) ? [] : e.isDirectory() ? filesUnder(join(root, e.name)) : [join(root, e.name)]);

export function assetRoot(file) {
  for (let p = dirname(file); ; p = dirname(p)) {
    if (existsSync(join(p, 'components')) || existsSync(join(p, '.git'))) return p;
    if (p === dirname(p)) return dirname(file);
  }
}

// 쓰기 대상 경로와 읽기 대상 sourceId는 경로 조각이 될 수 있는 값만 허용한다.
export function safeId(id) { if (!/^[\w.-]+$/.test(id) || id === '.' || id === '..') throw new Error(`잘못된 sourceId: ${id}`); return id; }

export function existingPatterns(dir, registry) {
  const candidates = [];
  const terms = ['Accordion', 'Tabs', 'Switch', 'Badge', 'Button', 'Input', 'Dialog', 'Select', 'Checkbox'];
  for (const s of registry.sources.filter(s => s.role === 'implementation' && s.kind === 'code')) {
    let output;
    try { output = execFileSync('git', ['-C', s.repo, 'grep', '-n', '-I', '-E', terms.join('|'), s.commit, '--', ...s.paths], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }); }
    catch (e) { if (e.status === 1) continue; throw e; }
    for (const line of output.trim().split('\n').filter(Boolean)) {
      const m = line.slice(s.commit.length + 1).match(/^(.+?):(\d+):(.*)$/);
      if (!m || !/\.[jt]sx?$/.test(m[1])) continue;
      const term = terms.find(t => new RegExp(`\\b${t}\\b`).test(m[3]));
      if (!term) continue;
      candidates.push({ sourceId: s.id, locator: `${m[1]}:${m[2]}`, term, snippet: m[3].trim().slice(0, 300) });
    }
  }
  const doc = seal({ schemaVersion: 1, kind: 'ExistingPatterns', inputDigests: registry.sources.filter(s => s.role === 'implementation').map(s => s.sha256), candidates });
  writeJson(join(dir, 'existing-patterns.json'), doc);
  return doc;
}

export async function capturePage(browser, url, options = {}) {
  try {
    const render = await navigate(browser, url, options);
    const dom = await browser.evaluate(`(${snapshotDOM.toString()})(${JSON.stringify({ probe: options.probe !== false })})`);
    return { render: { ...render, theme: dom.theme, engine: ENGINE }, ...dom };
  } catch (e) { throw new Error(`렌더 ${new URL(url).pathname}: ${e.message}`, { cause: e }); }
}

export function componentCandidates(elements, baseline) {
  return elements.map(e => ({ ...e, componentHint: null, componentCandidates: baseline.samples.filter(b => b.tag === e.tag && b.componentLabel === (e.componentName ?? e.kind)).map(b => ({ baseline: b.id, sharedClasses: e.classes.filter(c => b.classes.includes(c)) })) }));
}

function samplesFor(page, sourceId, file, dom) {
  const samples = [];
  for (const e of dom.elements) {
    if (!['button', 'input', 'badge', 'switch', 'tab'].includes(e.kind) && !e.componentName) continue;
    if (samples.some(b => canonical(b.classes) === canonical(e.classes) && canonical(b.style) === canonical(e.style))) continue;
    samples.push({ id: `B-${sourceId}-${sha256(`${file}|${e.locator}`).slice(0, 12)}`, sourceId, file, locator: e.locator, componentLabel: page, sizeAttribute: e.sizeAttribute, variantAttribute: e.variantAttribute, text: e.text, classes: e.classes, utilities: e.utilities, tokens: e.tokens, tag: e.tag, rect: e.rect, style: e.style });
  }
  return samples;
}

export async function designSpec(dir, options = {}) {
  dir = resolve(dir);
  const registry = readJson(join(dir, 'sources.json'));
  const designs = registry.sources.filter(s => s.role === 'design' && s.kind === 'design-html');
  for (const s of designs) safeId(s.id);
  existingPatterns(dir, registry);
  const out = join(dir, 'design-spec'); mkdirSync(out, { recursive: true });
  // 제거된 원본의 스냅샷은 남겨 재사용하지 않는다.
  for (const f of readdirSync(out)) if (f.endsWith('.json') && !designs.some(s => `${s.id}.json` === f)) rmSync(join(out, f));
  const chrome = findChrome(options.env ?? process.env);
  const skip = !designs.length ? 'design-html 없음' : !chrome ? 'chrome 없음' : null;
  if (skip) {
    for (const f of readdirSync(out)) rmSync(join(out, f), { force: true });
    rmSync(join(dir, 'component-baseline.json'), { force: true });
    const status = seal({ schemaVersion: 1, kind: 'DesignSpecStatus', status: 'skipped', reason: skip, sources: [] });
    writeJson(join(dir, 'design-spec-status.json'), status);
    return status;
  }
  const scratchRoot = join(dir, '.render'); mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(join(scratchRoot, 'capture-'));
  let browser;
  const servers = [];
  try {
    browser = await launchBrowser(chrome, scratch);
    const roots = new Map();
    for (const s of registry.sources.filter(s => s.role === 'design' && s.kind === 'code')) {
      roots.set(s.id, { repo: s.repo, commit: s.commit, paths: s.paths, inputDigest: sha256(canonical({ commit: s.commit, tree: s.sha256 })) });
    }
    for (const s of designs) {
      const root = assetRoot(s.path);
      if (![...roots.values()].some(x => x.root === root)) roots.set(`files-${s.id}`, { root, inputDigest: s.sha256 });
    }
    const baseline = { schemaVersion: 1, kind: 'ComponentBaseline', engine: ENGINE, browser: browser.version, theme: options.theme ?? null, inputDigests: [...roots.values()].map(x => x.inputDigest), pages: [], samples: [] };
    const referencedPages = new Set(designs.flatMap(s => [...readFileSync(s.path, 'utf8').matchAll(/(components\/[\w/-]+)\.(?:css|js|html)/g)].map(m => `${m[1]}.html`)));
    const old = existsSync(join(dir, 'component-baseline.json')) ? readJson(join(dir, 'component-baseline.json')) : null;
    // 같은 컴포넌트 페이지는 등록 커밋의 기준을 우선한다.
    const collected = new Set();
    for (const [sourceId, data] of roots) {
      const server = data.repo ? await serveGit(data.repo, data.commit) : await serve(data.root); servers.push(server);
      data.server = server;
      const components = data.root ? join(data.root, 'components') : null;
      const pages = data.repo ? execFileSync('git', ['-C', data.repo, 'ls-tree', '-r', '--name-only', data.commit, '--', ...data.paths], { encoding: 'utf8' }).trim().split('\n').filter(f => /(?:^|\/)components\/.*\.html$/.test(f)) : components && existsSync(components) ? filesUnder(components).filter(f => extname(f) === '.html').map(f => relative(data.root, f).split('\\').join('/')) : [];
      for (const rel of pages) {
        if (referencedPages.size && !referencedPages.has(rel)) continue;
        if (collected.has(rel)) continue;
        collected.add(rel);
        const cached = old?.engine === ENGINE && old.browser === browser.version && old.theme === baseline.theme && canonical(old.inputDigests) === canonical(baseline.inputDigests) ? old.pages.find(p => p.sourceId === sourceId && p.file === rel) : null;
        const valid = cached && cached.render.assets.every(a => a.path.startsWith('/') && !a.path.includes('?') && (data.repo || (existsSync(join(data.root, decodeURIComponent(a.path))) && sha256(readFileSync(join(data.root, decodeURIComponent(a.path)))) === a.digest)));
        if (valid) { baseline.pages.push(cached); baseline.samples.push(...old.samples.filter(b => b.sourceId === sourceId && b.file === rel)); continue; }
        const dom = await capturePage(browser, `${server.url}/${rel.split('/').map(encodeURIComponent).join('/')}`, { ...options, probe: false, localAssets: server.assets });
        baseline.pages.push({ sourceId, file: rel, render: dom.render });
        baseline.samples.push(...samplesFor(basename(rel, '.html'), sourceId, rel, dom));
      }
    }
    const fixedBaseline = seal(baseline); writeJson(join(dir, 'component-baseline.json'), fixedBaseline);
    const sources = [];
    for (const s of designs) {
      if (sha256(readFileSync(s.path)) !== s.sha256) throw new Error(`원본이 등록 후 변경됨: ${s.id}`);
      const root = assetRoot(s.path); const data = [...roots.values()].find(x => x.root === root);
      const path = relative(root, s.path).split('/').map(encodeURIComponent).join('/');
      const dom = await capturePage(browser, `${data.server.url}/${path}`, { ...options, localAssets: data.server.assets });
      const spec = seal({ schemaVersion: 1, kind: 'DesignSpec', sourceId: s.id, inputDigest: s.sha256, baselineDigest: fixedBaseline.digest, render: dom.render, reference: dom.reference, elements: componentCandidates(dom.elements, fixedBaseline), interactions: dom.interactions });
      writeJson(join(out, `${s.id}.json`), spec);
      sources.push({ sourceId: s.id, digest: spec.digest, elements: spec.elements.length, interactions: spec.interactions.length });
    }
    const status = seal({ schemaVersion: 1, kind: 'DesignSpecStatus', status: 'passed', sources, baselineDigest: fixedBaseline.digest });
    writeJson(join(dir, 'design-spec-status.json'), status);
    return status;
  } catch (e) {
    writeJson(join(dir, 'design-spec-status.json'), { schemaVersion: 1, kind: 'DesignSpecStatus', status: 'failed', reason: e.message, sources: [] });
    throw e;
  } finally {
    for (const s of servers) await s.close();
    await browser?.close();
    rmSync(scratch, { recursive: true, force: true });
    if (!readdirSync(scratchRoot).length) rmSync(scratchRoot, { recursive: true });
  }
}

if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  const args = process.argv.slice(2); const dir = args[0] === '--root' ? args[1] : args[0];
  if (!dir) { process.stderr.write('usage: node scripts/design-spec.mjs <case|--root dir>\n'); process.exit(2); }
  try { const status = await designSpec(dir); process.stdout.write(`${JSON.stringify(status)}\n`); }
  catch (e) { process.stderr.write(`${e.stack}\n`); process.exitCode = 1; }
}
