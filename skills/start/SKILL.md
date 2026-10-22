---
name: start
description: 기획·디자인 산출물을 개발 계획서로 바꾸는 작업을 시작한다. 작업 주제나 참조 자료(기획·디자인 시안·API 스펙·코드 레포·확정 결정)를 받아 사례 폴더와 inputs.json 을 만들고 터미널에서 돌릴 명령을 안내한다. Use when 기획서·프로토타입·디자인 시안에서 구현 계획을 뽑고 싶을 때, "작업계획 만들어줘", "입력 자료 정리해줘", "kiln-harness 시작".
---

# start — 입력 정의와 실행 안내

이 스킬은 **입력을 정하는 데까지**만 한다. 변환(범위 → 해석 → 검증 → 비평 → 렌더)은 터미널에서 `node scripts/run.mjs` 가 에이전트를 단계마다 새로 띄워 돌린다.
이 세션 안에서 파이프라인을 직접 실행하거나 `claude -p`·`codex exec` 를 부르지 않는다 — 세션 중첩과 토큰 낭비가 생긴다.

플러그인 루트(`KH`)는 이 `SKILL.md` 가 있는 폴더의 두 단계 위다(Claude Code 는 `${CLAUDE_PLUGIN_ROOT}` 도 쓸 수 있다). 아래 스크립트는 모두 `$KH/scripts/` 에 있다. Claude Code 와 Codex 어느 쪽 세션에서도 같다.

## 절차

1. **무엇을 받을지 정한다.** 사용자는 둘 중 아무거나 줄 수 있다.
   - **주제만** (한두 줄): 어떤 자료가 있는지 한 번에 묶어 묻는다(질문 도구가 있으면 그것을, 없으면 대화로) — 기획 산출물 · 디자인 시안 · API 스펙 · 코드 레포(프론트·백엔드 등) · 확정 결정/배경 문서 · 이전 사례(후속 작업). 경로를 달라고 한다.
   - **자료 목록만**: 읽고 주제를 한두 줄로 추론해 맞는지 확인한다.
2. **자료를 읽기 전용으로 훑는다.** `ls`, 파일 앞부분, `git -C <경로> rev-parse` 로 종류를 확인하고 역할을 추정한다.
   - 역할: `plan`(기획) · `design`(시안) · `contract`(API 스펙) · `implementation`(현재 코드) · `context`(확정 결정·배경).
   - 읽을 수 있는 형식: HTML·docx·Markdown·텍스트·JS/CSS/SVG·OpenAPI(yaml/json)·git 레포. **이미지·PDF 는 읽을 수 없다** — HTML 이나 텍스트로 변환해서 달라고 한다. git 이 아닌 폴더는 통째로 받지 않고 파일을 하나씩 지정한다.
   - 애매한 역할은 한 번에 모아서 묻는다. 기획(`plan`)이 하나도 없으면 시작할 수 없다고 알린다.
3. **정할 것을 정한다.**
   - 사례 이름(영문 소문자·하이픈). 후속 작업이면 이전 사례 이름(`previous`)과, 새 원본이 이전 원본의 어느 것을 대체하는지(`supersedes`).
   - 파일은 `copy`(기본, 사례 폴더에 스냅샷) / `reference`(원래 경로 유지 — 25MB 초과나 외부에 두고 싶을 때). 코드 레포는 항상 참조이고 커밋으로 고정된다. 레포마다 `ref`(브랜치·커밋)와 볼 `paths` 를 정한다. 백엔드 레포도 `implementation` 으로 하나 더 넣는다.
   - 없는 자료(예: API 스펙)는 억지로 만들지 않는다 — 없다는 사실이 그대로 에이전트에게 전달된다.
4. **spec 을 만든다.** 임시 파일에 아래 형식의 JSON 을 쓰고 먼저 `--dry` 로 분류를 확인한다.
   ```json
   { "case": "my-feature", "brief": "이번 작업이 무엇인지 1~3줄",
     "previous": { "case": "이전-사례" },
     "items": [
       { "path": "/abs/기획.html", "role": "plan" },
       { "path": "/abs/시안.html", "role": "design" },
       { "path": "/abs/api.yaml", "role": "contract" },
       { "path": "/abs/결정.md", "role": "context", "note": "확정 결정" },
       { "path": "/abs/frontend-repo", "role": "implementation", "ref": "origin/main", "paths": ["src"] } ] }
   ```
   ```bash
   node "$KH/scripts/intake.mjs" --spec <spec.json> --dry
   ```
   분류 표를 사용자에게 보여 주고 고칠 곳이 없으면 `--dry` 를 빼고 실행한다. 오류(경로 없음·읽을 수 없는 형식 등)는 사유대로 고쳐서 다시 한다. cases 폴더는 `--root` > `KH_CASES_DIR` > `./cases` > `./kiln-cases` 순으로 정해진다.
5. **결과를 안내한다.** 만들어진 사례 폴더, 참조 카탈로그 요약(역할별 자료와 **없는 자료 경고**), 스크립트가 출력한 실행 명령을 그대로 전한다. 덧붙일 것:
   - 계정을 나눠 쓰면 작업에 맞는 계정의 설정 폴더로 실행한다: `export CLAUDE_CONFIG_DIR=<설정 폴더>` (codex 는 `CODEX_HOME`).
   - 처음에는 `--attempts 3 --loops 1` 로 비용 상한을 둔다. 모델·러너는 `kh.config.json` 이나 `KH_<SCOPE|INTERPRET|CRITIC>_<RUNNER|MODEL|EFFORT>` 환경변수로 바꾼다.
   - 이미 산출물이 있는 사례를 다시 돌리면 최종 실패 시 삭제되므로 먼저 폴더를 복사해 둔다.
   - 결과는 `review.html`. 항목 id 에 결정을 남기려면 `decide` 스킬이나 `decide.mjs` 를 쓴다.

## 규칙

- 자료 원본을 수정하지 않는다. 사례 폴더(`cases/`·`kiln-cases/`)는 업무 자료라 git 에 올리지 않는다.
- 파이프라인을 이 세션에서 실행하지 않는다 — 명령만 안내한다. 변환 에이전트는 `claude` 와 `codex` 중 `kh.config.json` 에 적힌 것이 터미널에서 돈다(둘 다 지원).
- 샌드박스가 읽기 전용이라 사례 폴더를 만들 수 없으면, 만들 명령을 그대로 보여 주고 사용자가 터미널에서 실행하게 한다.
- 자료에 없는 사실로 spec 의 `brief` 를 부풀리지 않는다.
