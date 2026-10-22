---
name: decide
description: 검토 화면(review.html)의 항목 id 에 대한 사용자 결정을 기록하고 다시 돌릴 명령을 안내한다. Use when "R-07 은 기존 패턴 따르자", "Q-03 은 디자인에 확인", "이 항목은 이렇게 결정" 처럼 계획서의 id 에 결정을 남길 때.
---

# decide — 항목 결정 기록

`review.html` 은 읽기 전용이고 모든 항목에 id 가 있다. 사용자가 "이 id 는 이렇게 하겠다"고 말하면 그것을 `decisions.json` 에 기록한다. 기록은 스크립트(`decide.mjs`)가 하고, 이 스킬은 말을 `stance` 로 옮기고 결과를 확인한다.

플러그인 루트(`KH`)는 이 `SKILL.md` 가 있는 폴더의 두 단계 위다(Claude Code 는 `${CLAUDE_PLUGIN_ROOT}` 도 쓸 수 있다). Claude Code 와 Codex 어느 쪽 세션에서도 같다.

## 절차

1. **사례를 정한다.** 현재 폴더에 `workplan.json` 이 있으면 그 폴더, 아니면 `cases/`·`kiln-cases/` 아래에서 고르거나 묻는다.
2. **id·stance·결정 내용을 뽑는다.** 사용자의 말을 아래로 옮긴다. 애매하면 한 번만 묻는다.

   | 말 | stance |
   |---|---|
   | 기존 패턴(코드)을 따른다 | `follow-existing` |
   | 다시 검토한다 | `re-review` |
   | 기획에 확인한다 | `ask-plan` |
   | 디자인에 확인한다 | `ask-design` |
   | 백엔드에 확인한다 | `ask-backend` |
   | 이렇게 확정한다 | `decided` |

   결정 내용(`note`)은 사용자가 정한 방식 그대로 한두 문장으로 적는다. 사용자가 말하지 않은 근거를 지어내지 않는다.
3. **기록한다.**
   ```bash
   node "$KH/scripts/decide.mjs" <사례 폴더> <id> <stance> "<결정 내용>"
   node "$KH/scripts/decide.mjs" <사례 폴더> --list      # 확인 ([stale] = 항목이 바뀌어 재확인 필요)
   node "$KH/scripts/decide.mjs" <사례 폴더> --remove <id>
   ```
   없는 id 나 모르는 stance 는 스크립트가 거부한다 — 메시지를 그대로 전하고 다시 묻는다.
4. **반영 방법을 안내한다.** 결정은 터미널에서 `node "$KH/scripts/run.mjs" <사례 폴더>` 를 다시 돌려야 계획서에 반영된다. 결정만 바뀐 재실행은 범위와 세션을 이어받아 해당 항목만 다시 해석한다. 이 세션에서 직접 실행하지 않는다.
