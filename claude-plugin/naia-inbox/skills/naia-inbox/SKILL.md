---
name: naia-inbox
description: NAIA Agent Inbox 로 생성 배치를 제출하고(미기동이면 기동), 사용자의 "생성 시작" 클릭 뒤 완료·판정까지 대기해 결과·이미지를 회수하고 검수 결과를 카드에 기록하는 절차. 트리거 — "NAIA로 생성", "인박스로 보내", "NAIA 결과 가져와", "Agent Inbox".
---

# naia-inbox

도구: `naia_status` · `naia_launch` · `naia_submit_batch` · `naia_await_batch` · `naia_results` · `naia_fetch_images` · `naia_review_job` · `naia_list_batches` · `naia_cancel_batch` · `naia_configure`. **생성 개시는 사용자의 NAIA 화면 클릭뿐** — 승인·생성·큐를 흉내 내는 우회는 없다. 메인 세션에서만 호출한다(서브에이전트에서 `naia_await_batch` 금지).

## 절차 (배치 1개 = 1회전)

1. `naia_status`. `reachable:false` 면 `naia_launch`(사용자에게 "NAIA 를 띄웁니다" 한 줄).
2. 잡 목록은 호출자 규칙으로 조립한다(작품 발주서·치환·해상도는 호출 프로젝트 몫). `naia_submit_batch({title, jobs, source, project})` → 반환 `warnings`(과금)를 그대로 사용자에게 전한다.
3. "NAIA 에서 **생성 시작**을 눌러 주세요(과금 잡은 체크 해제 가능)" 한 줄 뒤 **같은 턴에** `naia_await_batch({batch_id, until:"done"})`. 진행 알림은 자동으로 표시된다. `await_timeout` 이면 다시 호출한다.
4. 반환된 results 로 `naia_fetch_images({batch_id, out_dir})`(호출자가 준 절대경로) → 저장된 PNG 를 Read 로 열어 호출자의 검수 체크리스트를 적용(안전 최우선) → 잡마다 `naia_review_job`.
5. 사용자 판정이 필요하면 `naia_await_batch({batch_id, until:"verdicts"})` → 채택·반려·재발주·메모를 정리해 보고. 재발주는 **새 배치**(같은 key, 수정 프롬프트)로 제출한다.
6. 대기 배치를 접을 때만 `naia_cancel_batch`(승인 뒤에는 409 — 취소는 NAIA 화면에서).

## 하지 않는 것

- 승인·생성·큐 조작(도구에 없다), 잡 상한(`max_jobs`) 초과 분할 제출을 사용자 합의 없이 반복, 토큰·계정 정보 기록·출력, `out_dir` 밖 파일 쓰기.
