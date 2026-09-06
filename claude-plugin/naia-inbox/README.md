# naia-inbox (Claude Code plugin)

NAIA 포크의 Agent Inbox를 Claude Code 세션에서 도구 호출로 다룬다 — 제출(`naia_submit_batch`), 미기동 시 기동(`naia_launch`),
완료·판정까지 대기(`naia_await_batch`), 결과·이미지 회수(`naia_results`, `naia_fetch_images`), 검수 기록(`naia_review_job`).
**생성 개시는 NAIA 화면의 사용자 클릭뿐** — 이 서버의 HTTP 화이트리스트에는 승인·생성·큐 경로가 없다.

설치: `claude plugin marketplace add SwiftlyAside/NAIA2.0` → `claude plugin install naia-inbox@naia`
개발: `claude plugin marketplace add F:\ai\NAIA2.0`
설정: `${CLAUDE_PLUGIN_DATA}/config.json` — `naia_configure` 도구로 조회·변경(env `NAIA_BASE_URL`·`NAIA_ROOT` 우선).
테스트: `node --test claude-plugin/naia-inbox/tests/`
