#!/usr/bin/env node
// S8 — 라이브 구현과 등록된 시안의 요소·동작·코드를 대조한다.
import { existsSync, mkdirSync, mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { findChrome, launchBrowser } from './lib/browser.mjs';
import { readDesignSpecs } from './lib/design-policy.mjs';
import { readJson, writeJson, seal, capturePage, componentCandidates } from './design-spec.mjs';
import { compareFacts, inspectCode, conformanceBrief } from './lib/conformance.mjs';
import { appendConformanceReview } from './lib/conformance-view.mjs';

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--root', '--url', '--theme', '--source', '--code'].includes(a)) {
      const v = argv[++i]; if (!v || v.startsWith('--')) throw new Error(`${a} 값이 필요함`);
      const key = a.slice(2); if (args[key] !== undefined) throw new Error(`${a} 중복`); args[key] = v;
    } else if (!a.startsWith('--') && !args.root) args.root = a;
    else throw new Error(`알 수 없는 인자: ${a}`);
  }
  if (!args.root || !args.url || !args.code) throw new Error('usage: node scripts/verify.mjs <case|--root dir> --url <http(s) URL> --code <기능 폴더> [--theme dark|light] [--source id]');
  const url = new URL(args.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('인증 정보 없는 http(s) URL이 필요함');
  if (args.theme && !['dark', 'light'].includes(args.theme)) throw new Error('--theme은 dark|light');
  return args;
}

export async function verify(rawDir, options, injected = {}) {
  const dir = resolve(rawDir); const registry = readJson(join(dir, 'sources.json'));
  if (options.theme && !['dark', 'light'].includes(options.theme)) throw new Error('--theme은 dark|light');
  const registered = registry.sources.filter(s => s.kind === 'design-html' && s.role === 'design');
  if (options.source && !registered.some(s => s.id === options.source)) throw new Error(`등록된 디자인 원본이 아님: ${options.source}`);
  let specs = readDesignSpecs(dir, registry);
  if (options.source) specs = specs.filter(s => s.sourceId === options.source);
  if (!options.source && specs.length > 1) throw new Error('디자인 원본이 여러 개임. --source로 구현 화면에 대응하는 원본을 지정한다');
  const base = { schemaVersion: 1, kind: 'Conformance', inputDigests: specs.map(s => s.digest), rows: [] };
  const finish = (body) => {
    const report = seal({ ...base, ...body });
    writeJson(join(dir, 'conformance.json'), report);
    writeFileSync(join(dir, 'conformance-brief.md'), conformanceBrief(report));
    appendConformanceReview(dir, report);
    return { report, exitCode: report.status === 'failed' ? 1 : report.status === 'needs-judgment' ? 3 : report.status === 'error' ? 2 : 0 };
  };
  if (!specs.length) return finish({ status: 'skipped', reason: 'design-spec 없음 또는 skipped' });
  const chrome = findChrome(options.env ?? process.env);
  if (!chrome) return finish({ status: 'skipped', reason: 'chrome 없음' });
  if (!options.code || !existsSync(options.code)) throw new Error('--code에 실재하는 기능 폴더가 필요함');
  const baseline = readJson(join(dir, 'component-baseline.json'));
  if (specs.some(s => s.baselineDigest !== baseline.digest)) throw new Error('시안과 컴포넌트 기준 digest가 다름. S2d를 다시 실행한다');
  const defaultConfig = readJson(new URL('../kh.config.json', import.meta.url));
  const localConfig = existsSync(join(dir, 'kh.config.json')) ? readJson(join(dir, 'kh.config.json')) : {};
  const tolerances = { ...defaultConfig.conformance?.tolerances, ...localConfig.conformance?.tolerances };
  const scratchRoot = join(dir, '.render'); mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(join(scratchRoot, 'verify-'));
  let browser;
  try {
    browser = await launchBrowser(chrome, scratch);
    const dom = await capturePage(browser, options.url, { theme: options.theme ?? specs[0].render.theme, ...specs[0].render.viewport });
    const implementation = seal({ schemaVersion: 1, kind: 'ImplementationSpec', render: dom.render, elements: componentCandidates(dom.elements, baseline), interactions: dom.interactions });
    const inspected = inspectCode(options.code, specs, baseline);
    const facts = seal({ schemaVersion: 1, kind: 'ConformanceFacts', inputDigests: specs.map(s => s.digest), tolerances, designs: specs, implementation, baseline,
      code: { digest: inspected.codeDigest, files: inspected.files, tokenDefinitions: inspected.definitions, existingPatterns: inspected.existingPatterns },
      facts: specs.flatMap(s => compareFacts(s, implementation, tolerances)).concat(inspected.facts) });
    writeJson(join(dir, 'conformance-facts.json'), facts);
    // 판단을 시작하기 전에 브라우저를 종료한다.
    await browser.close(); browser = null;
    let judgmentExit;
    if (injected.judge) await injected.judge(dir, facts);
    else {
      judgmentExit = 0;
      try { execFileSync(process.execPath, [new URL('./run.mjs', import.meta.url).pathname, dir, '--conformance'], { stdio: 'inherit' }); }
      catch (e) { if (![1, 3].includes(e.status)) throw e; judgmentExit = e.status; }
    }
    const report = readJson(join(dir, 'conformance.json'));
    if (report.factsDigest !== facts.digest) throw new Error('판정이 현재 사실 digest와 다름');
    if (judgmentExit !== undefined && judgmentExit !== (report.status === 'failed' ? 1 : report.status === 'needs-judgment' ? 3 : 0)) throw new Error('판정 프로세스의 종료 코드와 산출물 상태가 다름');
    return { report, exitCode: report.status === 'failed' ? 1 : report.status === 'needs-judgment' ? 3 : 0 };
  } catch (e) {
    finish({ status: 'error', reason: e.message });
    throw e;
  } finally {
    await browser?.close();
    rmSync(scratch, { recursive: true, force: true });
    if (!readdirSync(scratchRoot).length) rmSync(scratchRoot, { recursive: true });
  }
}

if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(2); }
  try { const { report, exitCode } = await verify(options.root, options); process.stdout.write(`${report.status}: ${JSON.stringify(report.counts ?? report.reason)}\n`); process.exitCode = exitCode; }
  catch (e) { process.stderr.write(`${e.stack}\n`); process.exitCode = 2; }
}
