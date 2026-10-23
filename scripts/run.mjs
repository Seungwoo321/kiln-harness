#!/usr/bin/env node
// 한 번에 돌리는 진입점 — S1 register → S2 extract → S3 scope → S4 interpret(+S5 validate) → S6 critic → S7 render.
// 터미널에서 직접 돌린다. 에이전트는 단계마다 새 세션(claude -p / codex exec)이고, 모델·runner 는 kh.config.json 에서 고른다.
//
// usage: node scripts/run.mjs <case-dir> [--open] [--force] [--attempts N] [--loops N] [--level 0-10]
//   --attempts  단계당 재시도 상한 (기본 3)      --loops  전체 재시작 상한 (기본 3)
//   --level     검토 수준 0~10 (기본 5, env KH_LEVEL). 낮을수록 끼워 맞춰 구현하고 구현 불가만 묻는다 · 높을수록 체계적으로 검증한다
//   --force     원본·결정이 그대로여도 처음부터 다시 돌린다
//   --open      끝나면 review.html 을 연다
// env: KH_<STAGE>_RUNNER|MODEL|EFFORT (STAGE = SCOPE|INTERPRET|CRITIC), KH_CONFIG 대신 사례 폴더의 kh.config.json 으로 덮어쓸 수 있다.
//      KH_CLAUDE · KH_CODEX  실행 파일 경로. 계정·config 는 호출한 셸 환경을 따른다.
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { parseLevel } from './lib/levels.mjs';
import { runPipeline } from './lib/pipeline.mjs';

function parseArgs(argv) {
  const args = { open: false, force: false, dir: null, stageAttempts: 0, loopAttempts: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--open') args.open = true;
    else if (a === '--force') args.force = true;
    else if (a === '--attempts') args.stageAttempts = Number(argv[(i += 1)]);
    else if (a === '--loops') args.loopAttempts = Number(argv[(i += 1)]);
    else if (a === '--level') args.level = argv[(i += 1)];
    else if (!a.startsWith('--') && !args.dir) args.dir = a;
    else { process.stderr.write(`알 수 없는 인자: ${a}\n`); process.exit(2); }
  }
  const bad = (n) => !Number.isInteger(n) || n < 0;
  if (!args.dir || bad(args.stageAttempts) || bad(args.loopAttempts)) {
    process.stderr.write('usage: node scripts/run.mjs <case-dir> [--open] [--force] [--attempts N] [--loops N] [--level 0-10]\n');
    process.exit(2);
  }
  args.dir = resolve(args.dir);
  if (args.level !== undefined) { try { args.level = parseLevel(args.level); } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(2); } }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const result = runPipeline(args.dir, args);
if (result.ok && args.open) execFileSync('open', [join(args.dir, 'review.html')]);
process.exit(result.ok ? 0 : result.needsInput ? 3 : 1); // 3 = 입력 보강 필요
