#!/usr/bin/env node
// S2c catalog — 이번 작업에서 근거로 쓸 수 있는 자료의 카탈로그(references.json)를 만든다. 해석은 하지 않는다.
// 작업마다 근거가 다르다: 사례 폴더 안의 산출물일 수도, 경로만 아는 코드 레포일 수도, API 스펙이 없을 수도, 백엔드 레포를 볼 수도 있다.
// 그래서 세션이 시작될 때 "무엇을 어떻게 읽을 수 있는지"와 "무엇이 없는지"가 모두 정해져 있어야 한다.
//   · 에이전트는 이 카탈로그에 있는 자료만 근거로 고른다(sourceRefs 의 sourceId).
//   · 필요한 자료가 카탈로그에 없으면 지어내지 않고 missingInputs 로 알린다 — 파이프라인은 재시도하지 않고 입력 보강을 요청한다.
// usage: node scripts/catalog.mjs <case-dir>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { canonical, sha256 } from './register.mjs';

const ROLE_HINT = {
  plan: '기획 산출물', design: '디자인 시안', contract: 'API 계약(스펙)', implementation: '현재 구현 코드', context: '확정 결정·배경 문서',
};
const COVERAGE_WARN = {
  plan: '기획 원본이 없다 — 요구사항의 출처가 없으므로 작업을 시작할 수 없다',
  design: '디자인 시안이 없다 — 화면 구성·상태는 기획과 현재 코드에서만 근거를 찾는다. 시안에서 온 것처럼 쓰지 않는다',
  contract: 'API 계약이 등록돼 있지 않다 — API·필드에 대한 사실은 단정하지 않는다. "계약에 없다"는 주장은 근거가 될 수 없다',
  implementation: '구현 코드가 등록돼 있지 않다 — 기존 파일·컴포넌트·패턴을 근거로 삼을 수 없다',
  context: '확정 결정·배경 문서가 없다',
};

const insideCase = (caseDir, p) => { const r = relative(caseDir, p); return !!r && !r.startsWith('..') && !isAbsolute(r); };

export function buildCatalog(caseDir) {
  const registry = JSON.parse(readFileSync(join(caseDir, 'sources.json'), 'utf8'));
  const anchorCount = (id) => { const f = join(caseDir, 'extract', `${id}.json`); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).anchors.length : null; };

  const sources = registry.sources.map((s) => {
    const base = { id: s.id, role: s.role, kind: s.kind, note: s.note ?? null, anchors: anchorCount(s.id) };
    if (s.kind === 'code') {
      const paths = s.paths?.length ? s.paths : ['.'];
      return { ...base, access: 'git', repo: s.repo, ref: s.ref, commit: s.commit, paths, entries: s.entries,
        read: [`git -C ${s.repo} show ${s.commit}:<경로>`, `git -C ${s.repo} grep -n <패턴> ${s.commit} -- ${paths.join(' ')}`, `git -C ${s.repo} ls-tree -r ${s.commit} -- ${paths.join(' ')}`] };
    }
    const text = existsSync(s.path) && s.kind !== 'plan-doc' ? readFileSync(s.path, 'utf8') : null;
    return { ...base, access: 'file', path: s.path, location: insideCase(caseDir, s.path) ? `사례 폴더 안 (${relative(caseDir, s.path)})` : '사례 폴더 밖', bytes: s.bytes, lines: text === null ? null : text.split('\n').length };
  });

  const byRole = Object.fromEntries(Object.keys(ROLE_HINT).map((r) => [r, sources.filter((x) => x.role === r).map((x) => x.id)]));
  const missingRoles = Object.keys(ROLE_HINT).filter((r) => byRole[r].length === 0);
  const catalog = { schemaVersion: 1, kind: 'ReferenceCatalog', caseId: registry.caseId, ...(registry.brief ? { brief: registry.brief } : {}), sources, byRole, missingRoles, warnings: missingRoles.map((r) => `${r}: ${COVERAGE_WARN[r]}`) };
  catalog.digest = sha256(canonical(catalog));
  writeFileSync(join(caseDir, 'references.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  return catalog;
}

// 에이전트 프롬프트에 넣는 압축 본문.
export function catalogText(c) {
  const lines = c.sources.map((s) => {
    const where = s.access === 'git'
      ? `git ${s.repo} @ ${s.commit.slice(0, 9)} · 범위 ${s.paths.join(', ')} · 파일 ${s.entries}개 · 읽기: git -C <repo> show|grep|ls-tree <commit>`
      : `파일 ${s.location}${s.lines ? ` · ${s.lines}줄` : ''} · ${s.path}`;
    return `  - ${s.id} (${s.role}, ${s.kind}) ${where}${s.note ? ` — ${s.note}` : ''}`;
  });
  const miss = c.warnings.length ? `\n- 없는 자료:\n${c.warnings.map((w) => `  · ${w}`).join('\n')}` : '';
  const brief = c.brief ? `\n\n[작업 주제]\n${c.brief}` : '';
  return `${brief}\n\n[참조 카탈로그 — references.json]\n근거로 쓸 수 있는 자료는 아래뿐이다. sourceRefs 의 sourceId 는 여기서 고른다. 여기 없는 자료·레포는 읽거나 인용하지 않는다.\n작업에 꼭 필요한 자료가 카탈로그에 없으면 지어내지 말고 최종 응답의 missingInputs 에 "무엇이 왜 필요한지"를 적고 status:"blocked" 로 멈춘다.\n${lines.join('\n')}${miss}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) { process.stderr.write('usage: node scripts/catalog.mjs <case-dir>\n'); process.exit(2); }
  const c = buildCatalog(resolve(dir));
  for (const s of c.sources) process.stdout.write(`${s.id}\t${s.role}\t${s.access}\t${s.location ?? s.repo}\n`);
  for (const w of c.warnings) process.stdout.write(`! ${w}\n`);
}
