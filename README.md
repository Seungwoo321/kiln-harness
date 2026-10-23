<p align="center"><img src="assets/banner.svg" alt="kiln-harness" width="100%"></p>

# kiln-harness

**기획·디자인 산출물 + 현재 코드·API 계약 → 바로 구현에 들어갈 수 있는 작업계획.** 같은 입력이면 같은 형식의 결과가 나온다.
Turn scattered planning docs, design mockups, API specs and the current codebase into one consistent, implementation-ready work plan — run by Claude Code or Codex agents, checked by deterministic gates.

- 무엇이 이번 작업 범위이고 무엇이 기존 화면인가
- 프로토타입이 담지 못한 상태(로딩·빈·오류·권한·비활성)는 무엇인가
- 어떤 컴포넌트를 어느 파일에 두고, 디자인 시스템의 무엇과 맞추는가
- 어떤 API 를 어느 화면·컴포넌트의 어떤 동작에 붙이는가
- 기획·디자인·백엔드에 무엇을 확인해야 하는가 (`확인 요청` / `알림`)

결과는 사람이 읽는 `review.html` 과 `WORKPLAN.md` 이다. 기획·디자인 산출물은 만드는 사람마다 다르다 — 이 하네스는 그것을 **공통 형식으로 바꾸는 변환 자체**이며, 입력과 산출물(`cases/`)만 비공개로 둔다.

## 설치

Claude Code 와 Codex 둘 다 지원한다. 같은 `skills/` 를 공유한다.

```bash
# Claude Code
/plugin marketplace add Seungwoo321/kiln-harness
/plugin install kiln-harness@kiln-harness

# Codex
codex plugin marketplace add Seungwoo321/kiln-harness
codex plugin add kiln-harness@kiln-harness
```

스킬은 두 개다.
- **`start`** — 작업 주제나 참조 자료(기획·디자인 시안·API 스펙·코드 레포·확정 결정)를 받아 사례 폴더와 `inputs.json` 을 만들고, 터미널에서 돌릴 명령을 안내한다.
- **`decide`** — 검토 화면의 항목 id 에 "이렇게 하겠다"를 기록한다.

변환 파이프라인은 스킬 안에서 돌지 않고 **터미널의 `node scripts/run.mjs`** 가 단계마다 새 세션으로 `claude -p` 또는 `codex exec` 를 띄워 돌린다. Node 22 이상이 필요하다.

## 검토 수준 (`--level 0~10`, 기본 5)

근거 자료로 구현을 어디까지 **끼워 맞추고**, 어디서부터 **물을지**를 정한다. 5 로 돌려 보고, 질문이 많으면 0~4 로, 끼워 맞춤이 의심스러우면 6~10 으로 이진 탐색하듯 좁힌다. 수준이 바뀌면 범위(`scope.json`)만 이어받고 계획서는 처음부터 다시 해석한다.

| 수준 | 동작 |
|---|---|
| 0~3 느슨 | 근거 자료에서 가장 가까운 해석으로 끼워 맞춰 구현한다. 끼워 맞춘 것은 `decisions`(`kind:"fitted"`, 검토한 다른 해석 `alternatives` 필수)로 남기고, 질문은 **구현이 불가능한 것**(`blocking:true` + `blockedReason` + 시도한 끼워 맞춤 `triedFits` 2개 이상, 0 은 3개 이상)만 남긴다 |
| 4~6 표준 | 5 = 원본이 답한 것은 결정, 원본끼리 다르거나 정의가 없으면 질문. 4 는 애매하면 원본을 따라 결정으로, 6 은 애매하면 질문으로 |
| 7~10 엄격 | 7 모든 요구사항·상태가 task 에 연결 · 8 비평이 화면마다 기획·디자인·계약을 모두 대조한 기록(`coverage`) 요구 · 9 요구사항마다 수용기준 2개 이상 · 10 가장 보수적인 판정 |

환경변수 `KH_LEVEL`, `kh.config.json` 의 `"level"` 로도 정한다(우선순위: `--level` > `KH_LEVEL` > 사례 폴더 설정 > 기본 5).

## 사용

```bash
node scripts/run.mjs cases/<case>                  # 한 번에: 등록 → 추출 → 카탈로그 → 범위 → 해석 → 검증 → 비평 → 렌더
node scripts/run.mjs cases/<case> --attempts 3 --loops 1   # 단계당 재시도 3회, 전체 재시작 1회(처음 돌릴 때 비용 상한)
node scripts/run.mjs cases/<case> --level 3               # 검토 수준 0~10 (기본 5). 낮을수록 끼워 맞춰 구현하고 구현 불가만 묻는다, 높을수록 체계적으로 검증한다
node scripts/decide.mjs cases/<case> <id> <stance> "<결정>"  # 검토 화면의 id 에 결정을 남긴다 → run.mjs 를 다시 돌리면 반영
node scripts/decide.mjs cases/<case> --list        # 남긴 결정 목록 ([stale] = 항목이 바뀌어 재확인 필요)
```

- 결과: `review.html`(변경 유형·지적·질문·결정 화면), `WORKPLAN.html`·`WORKPLAN.md`(전체 문서), `run-status.json`(단계별 시도·토큰·시간·위반).
- 종료 코드: `0` 통과 · `1` 실패(파생 산출물 삭제, 마지막 시도는 `failed/`) · `3` 입력 보강 필요(`run-status.json` 의 `missingInputs` — `inputs.json` 에 자료를 더하고 다시 실행).
- **같은 입력이면 건너뛴다.** 원본·결정이 그대로이고 현재 계획서가 검증을 통과하면 에이전트를 부르지 않는다. 강제로 처음부터는 `--force`.
- 단계별 러너·모델은 `kh.config.json`(기본) → `cases/<case>/kh.config.json` → 환경변수 `KH_<SCOPE|INTERPRET|CRITIC>_<RUNNER|MODEL|EFFORT|SESSION>` 순으로 덮는다. `claude`·`codex` 와 각 CLI 가 지원하는 모델이면 무엇이든 된다.
- 사례는 `cases/<case>/inputs.json` 에 원본 경로와 역할을 적어 시작한다(입력 구성은 `docs/pipeline.md`). 사례 폴더는 업무 자료라 레포에 올리지 않는다.
- 이미 만든 `workplan.json` 이 있는 사례를 다시 돌리면 **최종 실패 시 그 산출물이 삭제된다.** 먼저 사례 폴더를 복사해 둔다.

## 동작 방식

```
inputs.json ─▶ register ─▶ extract ─▶ catalog ─▶ scope ─▶ interpret ─▶ (validate) ─▶ critic ─▶ render
  (자료·역할)    (sha256)    (앵커)     (참조 카탈로그)   (범위)      (해석)       (게이트)       (비평)    (review.html …)
```

- 결정적 처리(등록·추출·카탈로그·검증·렌더)는 스크립트가, 판단(범위·해석·비평)은 에이전트(`roles/*.md`)가 맡는다.
- 단계마다 게이트가 결과를 검사하고, 위반은 다음 시도에 주입된다(단계당 최대 3회, 전체 최대 3회). 최종 실패하면 파생 산출물을 지우고 처음부터 다시 한다.
- 같은 주제 안에서는 세션 id 로 대화를 이어간다(비평은 생산자와 분리하려고 새 세션).
- 질문은 담당자에게 전달되는 두 종류(`confirm` · `notice`)만 남고, 원본이 이미 답한 것은 근거와 함께 `decisions` 로 기록된다.
- 후속 작업은 이전 사례를 링크해 바뀐 부분만 범위로 잡고 이전 결정을 이어받는다.

## 문서

- [`docs/pipeline.md`](docs/pipeline.md) — 단계, 게이트, 실행 구조, 입력 구성
- [`docs/workplan-format.md`](docs/workplan-format.md) — 산출물 형식과 판정 규칙

## 개발

```bash
node --test 'scripts/*.test.mjs'          # 시험
claude --plugin-dir .                       # Claude Code 에서 로컬 플러그인 로드
codex plugin marketplace add .              # Codex 에서 로컬 마켓플레이스 추가
```

## 라이선스

[MIT](LICENSE)
