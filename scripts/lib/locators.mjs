// locator 해석기 — sourceRefs 의 locator 가 그 원본에 실제로 있는지 결정적으로 판정한다.
// 근거 없는 주장("X 가 없다")이 질문이 되는 것을 막는 게이트의 바탕이다. 판단은 하지 않는다.
//
// 인정하는 형식
//   L<시작>-<끝> · L<줄>        행 범위 (원본 줄 수 안)
//   path:line                   코드 파일 (등록된 코드 앵커에 있는 경로)
//   #id · [data-panel=…] · SCREENS['key'] · 주석 마커 문구 · 문서 절 경로 · operationId · 스키마 이름
//                               → 앵커 값과 일치하거나, 원본 본문에 그 문자열이 실제로 있어야 한다
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const MIN_CORE = 3;

function coreOf(locator) {
  let s = String(locator ?? '').trim();
  const attr = s.match(/^\[data-[\w-]+=["']?([^\]"']+)["']?\]$/);
  if (attr) return attr[1];
  const screen = s.match(/^SCREENS\[['"]([^'"]+)['"]\]$/);
  if (screen) return screen[1];
  s = s.replace(/^#/, '').replace(/^["'`]|["'`]$/g, '');
  return s;
}

export function makeResolver(caseDir, registry, extractsById = null) {
  const extracts = new Map();
  const texts = new Map();
  const anchorsOf = (id) => {
    if (extractsById?.[id]) return extractsById[id].anchors;
    if (!extracts.has(id)) extracts.set(id, JSON.parse(readFileSync(join(caseDir, 'extract', `${id}.json`), 'utf8')).anchors);
    return extracts.get(id);
  };
  const textOf = (source) => {
    if (texts.has(source.id)) return texts.get(source.id);
    let text = null;
    try {
      if (source.kind === 'code') text = source.role === 'contract' ? execFileSync('git', ['-C', source.repo, 'show', `${source.commit}:${source.paths[0]}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }) : null;
      else if (source.kind !== 'plan-doc') text = readFileSync(source.path, 'utf8');
    } catch { text = null; }
    texts.set(source.id, text);
    return text;
  };

  return {
    resolve(sourceId, locator) {
      const source = registry.sources.find((s) => s.id === sourceId);
      if (!source) return { ok: false, reason: `등록되지 않은 sourceId — ${sourceId}` };
      const loc = String(locator ?? '').trim();
      if (!loc) return { ok: false, reason: 'locator 가 비었음' };
      const anchors = anchorsOf(sourceId);

      const range = loc.match(/^L(\d+)(?:-(\d+))?$/);
      if (range) {
        const text = textOf(source);
        if (text === null) return { ok: false, reason: `${source.kind} 원본에는 행 범위 locator 를 쓸 수 없음` };
        const total = text.split('\n').length;
        const [a, b] = [Number(range[1]), Number(range[2] ?? range[1])];
        return a >= 1 && b >= a && b <= total ? { ok: true, how: 'line' } : { ok: false, reason: `행 범위가 원본(${total}줄) 밖 — ${loc}` };
      }
      const pathLine = loc.match(/^(.+):(\d+)$/);
      if (pathLine && source.kind === 'code') {
        return anchors.some((a) => a.type === 'file' && a.value === pathLine[1]) ? { ok: true, how: 'file' } : { ok: false, reason: `코드 원본에 없는 경로 — ${pathLine[1]}` };
      }
      const core = coreOf(loc);
      if (anchors.some((a) => a.value === core || a.section === core || (a.section ?? '').startsWith(`${core} >`) || (a.file ?? '') === core)) return { ok: true, how: 'anchor' };
      if (core.length < MIN_CORE) return { ok: false, reason: `앵커에 없고 너무 짧아 본문에서 위치를 특정하지 못함 — ${loc}` };
      const text = textOf(source);
      if (text !== null && text.includes(core)) return { ok: true, how: 'text' };
      if (source.kind === 'plan-doc' && anchors.some((a) => String(a.value ?? JSON.stringify(a.rows ?? '')).includes(core))) return { ok: true, how: 'anchor-text' };
      return { ok: false, reason: `원본에 없는 locator — ${sourceId} ${loc}` };
    },
  };
}
