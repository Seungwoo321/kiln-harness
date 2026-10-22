# kiln-harness

기획·디자인 산출물을 개발용 작업계획으로 변환하는 하네스. 개요는 `README.md`, 단계는 `docs/pipeline.md`,
산출물 형식은 `docs/workplan-format.md` 가 소유한다.

## 규칙

- 결정적인 처리(등록·추출·검증·렌더)는 `scripts/` 가 소유한다. LLM 판단은 `roles/` 의 역할 파일을 `scripts/run.mjs` 가 `claude -p`·`codex exec` 로 단계마다 새 세션으로 실행해서만 하고(스킬·세션 중첩 호출 ❌), 결과는 단계 게이트(`validate.mjs` 등)를 통과해야 한다.
- 같은 입력이면 같은 출력이어야 한다. 스크립트에 시각·난수·작업 트리 상태를 섞지 않는다 — 코드 원본은 커밋으로 고정해 읽는다.
- `cases/` 는 업무 자료와 그 해석이다. 커밋하지 않는다(`.gitignore`).
- 산출물(`workplan.json`, `WORKPLAN.md`)에는 이 하네스나 도구 이름을 적지 않는다.
- 패키지 매니저는 pnpm. 스크립트는 Node 내장 모듈만 쓴다.
- **하네스는 범용이다.** 기획·디자인 산출물은 만드는 사람마다 다르고, 이 하네스는 그것을 공통 형식(작업계획)으로 바꾸는 변환 자체다 — 본체(`scripts/`·`roles/`·`skills/`·`docs/`·`kh.config.json`·테스트)는 특정 제품·회사·도구에 묶이지 않고 공개해도 되는 것만 둔다. 비공개인 것은 입력과 산출물뿐이며, 원본·티켓·결정·계획서는 `cases/<case>/` 에만 둔다(gitignore). 본체에 사내 식별자·경로·티켓 키·제품 용어를 넣지 않는다 — 테스트 픽스처도 가상 데이터를 쓴다.
- 이 레포는 Claude Code 플러그인(`.claude-plugin/`)이자 Codex 플러그인(`.codex-plugin/`, `.agents/plugins/`)이다. 두 도구가 `skills/` 를 공유하므로 스킬 본문은 도구 특정 기능에 기대지 않는다.
- 파이프라인의 에이전트 러너는 `claude` 와 `codex` 둘 다 지원한다(`kh.config.json`). 새 기능은 두 러너에서 모두 동작해야 한다.
