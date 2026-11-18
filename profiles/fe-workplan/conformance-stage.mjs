// S8 구현 적합성 판정 — 수집된 렌더·코드 사실(conformance-facts.json)을 별도 역할 세션이 판정한다(run.mjs --conformance).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonical, sha256 } from '../../scripts/register.mjs';
import { runStage, loadConfig, newStat, writeRunStatus } from '../../scripts/lib/pipeline.mjs';
import { runAgent as realRunAgent } from '../../scripts/lib/runner.mjs';
import { BLOCKING, judgmentErrors, groundJudgments, conformanceBrief } from './lib/conformance.mjs';
import { appendConformanceReview } from './lib/conformance-view.mjs';
import profile from './profile.mjs';

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const tryJson = (file) => { try { return readJson(file); } catch { return null; } };

export function conformanceGate(dir, facts) {
  const draft = tryJson(join(dir, 'stages', 'conformance.json'));
  const violations = judgmentErrors(draft, facts);
  return { violations, value: violations.length ? draft : groundJudgments(draft, facts) };
}

export function runConformance(rawDir, opts = {}, injected = {}) {
  const dir = resolve(rawDir); const facts = readJson(join(dir, 'conformance-facts.json'));
  const { digest, ...body } = facts;
  if (sha256(canonical(body)) !== digest) throw new Error('conformance-facts digest 불일치');
  if (!Array.isArray(facts.facts) || !facts.facts.length) throw new Error('판정할 렌더·코드 사실이 없음');
  const cfg = loadConfig(dir, opts.env ?? process.env);
  const fingerprint = sha256(canonical({ facts: digest, role: profile.role('conformance'), contract: sha256(readFileSync(new URL('./lib/conformance.mjs', import.meta.url))), config: cfg.stages.conformance }));
  const save = (report) => {
    writeFileSync(join(dir, 'conformance.json'), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(dir, 'conformance-brief.md'), conformanceBrief(report));
    appendConformanceReview(dir, report);
    return { ok: report.status === 'passed', needsInput: report.status === 'needs-judgment' ? [report.reason] : undefined, report };
  };
  const old = tryJson(join(dir, 'conformance.json'));
  const oldBody = old ? Object.fromEntries(Object.entries(old).filter(([k]) => k !== 'digest')) : null;
  if (!opts.force && old?.judgmentFingerprint === fingerprint && sha256(canonical(oldBody)) === old.digest && old.status === (old.rows.some(r => BLOCKING.has(r.verdict)) ? 'failed' : 'passed') && judgmentErrors(old, facts).length === 0) return save(old);
  const registry = readJson(join(dir, 'sources.json'));
  mkdirSync(join(dir, 'stages'), { recursive: true });
  const stat = newStat();
  const r = runStage({ name: 'conformance', dir, registry, cfg: { ...cfg.stages.conformance, session: 'fresh' }, limits: cfg.limits, deps: { runAgent: injected.runAgent ?? realRunAgent, log: injected.log ?? ((s, m) => process.stdout.write(`[${s}] ${m}\n`)) }, ctx: { profile }, gate: () => conformanceGate(dir, facts), outFile: 'conformance.json', stat, chain: { ids: {}, started: {} } });
  const rows = r.ok ? r.value.rows : [];
  const status = r.ok ? rows.some(x => BLOCKING.has(x.verdict)) ? 'failed' : 'passed' : 'needs-judgment';
  const report = { schemaVersion: 1, kind: 'Conformance', status, factsDigest: digest, inputDigests: facts.inputDigests, judgmentFingerprint: fingerprint, rows, facts: facts.facts,
    ...(r.ok ? {} : { reason: r.needsInput?.join(' / ') ?? r.violations.join('\n') }), counts: Object.fromEntries([...new Set(rows.map(x => x.verdict))].sort().map(v => [v, rows.filter(x => x.verdict === v).length])) };
  report.digest = sha256(canonical(report));
  writeRunStatus(dir, { ...tryJson(join(dir, 'run-status.json')), conformance: { result: status, factsDigest: digest, attempts: r.attempts, usage: stat, violations: r.violations ?? [] } }, profile);
  return save(report);
}
