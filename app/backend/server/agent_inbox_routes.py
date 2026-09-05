"""Agent Inbox — REST(에이전트용) · WS 명령(UI용) · 이벤트→WS 브릿지.

ToS 경계: 큐 적재(승인)는 WS 명령 ``agent_inbox_approve`` 로만 한다. 이 모듈의 REST 에는
승인·생성 엔드포인트가 없다(tests/agent_inbox/test_routes.py 가 부재를 검증).
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, Awaitable, Callable

from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import JSONResponse

from app.backend.server.generation_commands import enqueue_generation_request
from core.headless_agent_inbox_service import MAX_JOBS_DEFAULT, AgentInboxError, AgentInboxService
from core.web_session_context import WebSessionContext

RunInThread = Callable[..., Awaitable[Any]]
BroadcastJson = Callable[[set[WebSocket], dict[str, Any]], Awaitable[None]]
GenerationRunnerStarter = Callable[[WebSessionContext, set[WebSocket]], None]

AGENT_INBOX_COMMAND_TYPES = {
    "agent_inbox_approve", "agent_inbox_reject", "agent_inbox_cancel",
    "agent_inbox_verdict", "agent_inbox_skip_job", "agent_inbox_refresh",
}
_EVENT_NAMES = ("queue_request_dequeued", "generation_result_available", "generation_request_failed",
                "queue_request_removed", "queue_cleared")


def _storage_dir(context: Any) -> Path:
    paths = getattr(context, "runtime_paths", None)
    if paths is not None:
        return Path(paths.data_dir) / "agent_inbox"
    return Path(getattr(context, "repo_root", ".")) / "save" / "agent_inbox"


def agent_inbox_service(context: Any) -> AgentInboxService:
    service = getattr(context, "agent_inbox_service", None)
    if service is None:
        service = AgentInboxService(_storage_dir(context), max_jobs=MAX_JOBS_DEFAULT)
        service.load_all()
        context.agent_inbox_service = service
    return service


def _history_lookup(context: Any) -> Callable[[str], dict[str, Any] | None]:
    def lookup(request_id: str) -> dict[str, Any] | None:
        store = getattr(context, "result_store", None)
        finder = getattr(store, "find_by_generation_request_id", None)
        item = finder(request_id) if callable(finder) else None
        if item is None:
            return None
        params = dict(getattr(item, "generation_params", None) or {})
        safe = {k: v for k, v in params.items() if k != "credential" and not str(k).startswith("_")}
        return {
            "history_id": getattr(item, "history_id", ""), "file_path": getattr(item, "filepath", ""),
            "rel_path": getattr(item, "rel_path", ""),
            "prompt": params.get("input") or params.get("prompt") or "",
            "negative": params.get("negative_prompt") or "",
            "params": safe,
        }
    return lookup


def _schedule(context: Any, clients: set[WebSocket], broadcast_json: BroadcastJson, message: dict[str, Any]) -> None:
    """임의 스레드(이벤트 버스)에서 메인 루프로 방송을 예약한다. 루프가 없으면(테스트) 직접 실행."""
    loop = getattr(context, "headless_main_loop", None)
    if loop is None:
        try:
            asyncio.run(broadcast_json(clients, message))
        except RuntimeError:
            pass
        return
    loop.call_soon_threadsafe(lambda: asyncio.ensure_future(broadcast_json(clients, message)))


def _broadcast_state(context: Any, clients: set[WebSocket], broadcast_json: BroadcastJson) -> None:
    service = agent_inbox_service(context)
    _schedule(context, clients, broadcast_json, service.state_payload())
    for note in service.pop_done_notifications():
        _schedule(context, clients, broadcast_json, note)


def _register_event_bridge(context: Any, clients: set[WebSocket], broadcast_json: BroadcastJson) -> None:
    service = agent_inbox_service(context)
    lookup = _history_lookup(context)

    def make_handler(name: str):
        def _on_event(payload: Any) -> None:
            try:
                changed = service.handle_event(name, payload if isinstance(payload, dict) else {}, history_lookup=lookup)
                if changed:
                    _broadcast_state(context, clients, broadcast_json)
            except Exception:
                pass
        return _on_event

    for name in _EVENT_NAMES:
        context.subscribe(name, make_handler(name))


def register_agent_inbox_routes(
    app: FastAPI, context: WebSessionContext, *, clients: set[WebSocket], run_in_thread: RunInThread,
    broadcast_json: BroadcastJson, start_generation_runner: GenerationRunnerStarter,
) -> None:
    service = agent_inbox_service(context)
    _register_event_bridge(context, clients, broadcast_json)

    def _error(exc: AgentInboxError) -> JSONResponse:
        return JSONResponse({"ok": False, "error": exc.detail}, status_code=exc.status)

    @app.post("/api/agent-inbox/batches")
    async def api_agent_inbox_submit(req: Request):
        try:
            payload = await req.json()
        except Exception:
            payload = None
        try:
            batch, warnings = await run_in_thread(service.submit, payload)
        except AgentInboxError as exc:
            return _error(exc)
        summary = service.summary(batch)
        await broadcast_json(clients, {"type": "agent_inbox_new", "batch_id": batch["batch_id"], "source": batch["source"],
                                       "project": batch["project"], "title": batch["title"],
                                       "job_count": len(batch["jobs"]), "paid_jobs": summary["paid_jobs"]})
        await broadcast_json(clients, service.state_payload())
        return {"ok": True, "batch_id": batch["batch_id"], "status": batch["status"],
                "job_count": len(batch["jobs"]), "warnings": warnings}

    @app.get("/api/agent-inbox/batches")
    async def api_agent_inbox_list(status: str = "", source: str = "", limit: int = 50):
        return {"batches": service.list_batches(status=status or None, source=source or None, limit=limit)}

    @app.get("/api/agent-inbox/batches/{batch_id}")
    async def api_agent_inbox_get(batch_id: str):
        try:
            return service.get_batch(batch_id)
        except AgentInboxError as exc:
            return _error(exc)

    @app.get("/api/agent-inbox/batches/{batch_id}/results")
    async def api_agent_inbox_results(batch_id: str):
        try:
            return service.results_payload(batch_id)
        except AgentInboxError as exc:
            return _error(exc)

    @app.post("/api/agent-inbox/batches/{batch_id}/cancel")
    async def api_agent_inbox_cancel(batch_id: str):
        try:
            batch = await run_in_thread(service.cancel_batch, batch_id)
        except AgentInboxError as exc:
            return _error(exc)
        await broadcast_json(clients, service.state_payload())
        return {"ok": True, "batch_id": batch["batch_id"], "status": batch["status"]}

    @app.post("/api/agent-inbox/jobs/{job_id}/agent-review")
    async def api_agent_inbox_agent_review(job_id: str, req: Request):
        try:
            payload = await req.json()
        except Exception:
            payload = None
        try:
            job = await run_in_thread(service.set_agent_review, job_id, payload)
        except AgentInboxError as exc:
            return _error(exc)
        await broadcast_json(clients, service.state_payload())
        return {"ok": True, "job_id": job["job_id"], "agent_review": job["agent_review"]}

    @app.get("/api/agent-inbox/settings")
    async def api_agent_inbox_settings():
        return {"max_jobs_per_batch": service.max_jobs, "retention_days": service.retention_days,
                "storage_dir": str(service.storage_dir)}


async def _send(ws: WebSocket, payload: dict[str, Any]) -> None:
    await ws.send_text(json.dumps(payload, ensure_ascii=False))


async def handle_agent_inbox_command(
    ws: WebSocket, context: WebSessionContext, clients: set[WebSocket], command: dict[str, Any], *,
    run_in_thread: RunInThread, broadcast_json: BroadcastJson, start_generation_runner: GenerationRunnerStarter,
) -> None:
    """UI(브라우저)에서 온 사용자 행위. 승인이 큐에 적재하는 유일한 경로다."""
    service = agent_inbox_service(context)
    ctype = str(command.get("type") or "")
    try:
        if ctype == "agent_inbox_refresh":
            await _send(ws, service.state_payload())
            return
        if ctype == "agent_inbox_approve":
            batch_id = str(command.get("batch_id") or "")
            job_ids = command.get("job_ids") if isinstance(command.get("job_ids"), list) else None
            jobs = service.approvable_jobs(batch_id, job_ids)
            if not jobs:
                raise AgentInboxError("no pending jobs to approve", 409)
            # 승인에서 뺀 잡(체크 해제)은 skipped 로 확정 — 남겨 두면 배치가 영영 done 이 되지 않는다.
            selected = {job["job_id"] for job in jobs}
            for left in service.approvable_jobs(batch_id):
                if left["job_id"] not in selected:
                    await run_in_thread(service.skip_job, left["job_id"])
            await run_in_thread(service.mark_batch_approved, batch_id)
            queued = 0
            for job in jobs:
                gen_command = {
                    "type": "generate", "prompt": job["prompt"], "negative_prompt": job["negative"],
                    "overrides": {**job["params"], "api_mode": "NAI",
                                  "_remote_queue_source": "Agent Inbox", "_remote_queue_label": job["key"]},
                }
                try:
                    result = await enqueue_generation_request(context, gen_command)
                except Exception as exc:
                    await run_in_thread(service.mark_job_failed, job["job_id"], str(exc))
                    continue
                if not result.ok:
                    await run_in_thread(service.mark_job_failed, job["job_id"], str(result.blocked_reason))
                    continue
                await run_in_thread(service.mark_job_queued, job["job_id"], str(result.request_id))
                queued += 1
            await _send(ws, {"type": "toast", "level": "success" if queued else "error",
                             "message": f"Agent Inbox: {queued}/{len(jobs)} 잡 큐 적재"})
            if queued and getattr(context, "headless_generation_execute_enabled", True):
                start_generation_runner(context, clients)
            if hasattr(context, "queue_state_payload"):
                await broadcast_json(clients, context.queue_state_payload())
        elif ctype == "agent_inbox_reject":
            await run_in_thread(service.reject_batch, str(command.get("batch_id") or ""), str(command.get("note") or ""))
        elif ctype == "agent_inbox_cancel":
            request_ids = await run_in_thread(service.cancel_generating, str(command.get("batch_id") or ""))
            manager = getattr(context, "generation_queue_manager", None)
            for rid in request_ids:
                if manager is not None:
                    removed = await run_in_thread(manager.remove_request, rid)
                    if removed:
                        service.handle_event("queue_request_removed", {"request_id": rid})
            if hasattr(context, "queue_state_payload"):
                await broadcast_json(clients, context.queue_state_payload())
        elif ctype == "agent_inbox_verdict":
            await run_in_thread(service.set_verdict, str(command.get("job_id") or ""),
                                str(command.get("decision") or ""), str(command.get("note") or ""), "user")
        elif ctype == "agent_inbox_skip_job":
            await run_in_thread(service.skip_job, str(command.get("job_id") or ""))
        else:
            raise AgentInboxError(f"unsupported command: {ctype}")
    except AgentInboxError as exc:
        await _send(ws, {"type": "toast", "level": "error", "message": f"Agent Inbox: {exc.detail}"})
        return
    await broadcast_json(clients, service.state_payload())
    for note in service.pop_done_notifications():
        await broadcast_json(clients, note)
