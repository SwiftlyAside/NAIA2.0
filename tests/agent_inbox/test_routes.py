import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.backend.server import agent_inbox_routes as routes
from core.headless_event_bus import WebSessionEventBus


class FakeStore:
    def __init__(self):
        self.items = {}

    def find_by_generation_request_id(self, rid):
        return self.items.get(rid)

    def history_summary(self, item, index=0):
        return {"history_id": item.history_id, "file_path": item.filepath, "rel_path": item.rel_path}


class FakeContext:
    def __init__(self, tmp_path):
        self.event_bus = WebSessionEventBus()
        self.runtime_paths = SimpleNamespace(data_dir=Path(tmp_path) / "data")
        self.repo_root = str(tmp_path)
        self.result_store = FakeStore()
        self.headless_main_loop = None
        self.headless_generation_execute_enabled = True

    def subscribe(self, name, fn):
        self.event_bus.subscribe(name, fn)

    def publish(self, name, *a, **k):
        self.event_bus.publish(name, *a, **k)


class FakeWs:
    def __init__(self):
        self.sent = []

    async def send_text(self, text):
        self.sent.append(json.loads(text))


def make_app(tmp_path):
    ctx = FakeContext(tmp_path)
    app = FastAPI()
    broadcasts = []

    async def broadcast_json(clients, data):
        broadcasts.append(data)

    started = []

    def start_runner(context, clients):
        started.append(True)

    async def run_in_thread(fn, *a, **k):
        return fn(*a, **k)

    routes.register_agent_inbox_routes(app, ctx, clients=set(), run_in_thread=run_in_thread,
                                       broadcast_json=broadcast_json, start_generation_runner=start_runner)
    return app, ctx, broadcasts, started, broadcast_json, run_in_thread, start_runner


def batch_payload(n=2):
    return {"source": "genit", "project": "p", "title": "t", "jobs": [
        {"key": f"E{i}", "prompt": f"p{i}", "negative": "n", "params": {"seed": i, "width": 832, "height": 1216, "steps": 28}}
        for i in range(1, n + 1)]}


def test_rest_submit_list_get_results_cancel(tmp_path):
    app, ctx, broadcasts, *_ = make_app(tmp_path)
    c = TestClient(app)
    r = c.post("/api/agent-inbox/batches", json=batch_payload())
    assert r.status_code == 200 and r.json()["job_count"] == 2
    bid = r.json()["batch_id"]
    assert any(b["type"] == "agent_inbox_new" and b["batch_id"] == bid for b in broadcasts)
    assert any(b["type"] == "agent_inbox_state" for b in broadcasts)
    assert c.get("/api/agent-inbox/batches").json()["batches"][0]["batch_id"] == bid
    assert c.get(f"/api/agent-inbox/batches/{bid}").json()["jobs"][0]["key"] == "E1"
    assert c.get(f"/api/agent-inbox/batches/{bid}/results").json()["jobs"][0]["status"] == "pending"
    assert c.get("/api/agent-inbox/batches/nope").status_code == 404
    assert c.post("/api/agent-inbox/batches", json={"jobs": []}).status_code == 400
    assert c.post(f"/api/agent-inbox/batches/{bid}/cancel").json()["status"] == "cancelled"
    assert c.post(f"/api/agent-inbox/batches/{bid}/cancel").status_code == 409
    assert c.get("/api/agent-inbox/settings").json()["max_jobs_per_batch"] == 9


def test_rest_agent_review(tmp_path):
    app, *_ = make_app(tmp_path)
    c = TestClient(app)
    bid = c.post("/api/agent-inbox/batches", json=batch_payload(1)).json()["batch_id"]
    jid = c.get(f"/api/agent-inbox/batches/{bid}").json()["jobs"][0]["job_id"]
    r = c.post(f"/api/agent-inbox/jobs/{jid}/agent-review", json={"safety": "pass", "note": "ok"})
    assert r.status_code == 200 and r.json()["agent_review"]["safety"] == "pass"
    assert c.post(f"/api/agent-inbox/jobs/{jid}/agent-review", json={"safety": "??"}).status_code == 400


def test_rest_has_no_approve_or_generate_routes(tmp_path):
    app, *_ = make_app(tmp_path)
    paths = {getattr(r, "path", "") for r in app.routes}
    assert not any("approve" in p or "generate" in p or "verdict" in p for p in paths)
    assert all(p.startswith("/api/agent-inbox") for p in paths if p.startswith("/api/"))


def test_ws_approve_enqueues_and_starts_runner(tmp_path, monkeypatch):
    app, ctx, broadcasts, started, broadcast_json, run_in_thread, start_runner = make_app(tmp_path)
    c = TestClient(app)
    bid = c.post("/api/agent-inbox/batches", json=batch_payload(2)).json()["batch_id"]
    calls = []

    async def fake_enqueue(context, command):
        calls.append(command)
        rid = f"req-{len(calls)}"
        return SimpleNamespace(ok=True, request_id=rid, blocked_reason="",
                               websocket_payload=lambda: {"type": "generation_queued", "request_id": rid})

    monkeypatch.setattr(routes, "enqueue_generation_request", fake_enqueue)
    ws = FakeWs()
    asyncio.run(routes.handle_agent_inbox_command(ws, ctx, set(), {"type": "agent_inbox_approve", "batch_id": bid},
                                                  run_in_thread=run_in_thread, broadcast_json=broadcast_json,
                                                  start_generation_runner=start_runner))
    assert len(calls) == 2 and started == [True]
    assert calls[0]["prompt"] == "p1" and calls[0]["negative_prompt"] == "n"
    assert calls[0]["overrides"]["_remote_queue_source"] == "Agent Inbox" and calls[0]["overrides"]["_remote_queue_label"] == "E1"
    assert calls[0]["overrides"]["api_mode"] == "NAI" and calls[0]["overrides"]["seed"] == 1
    b = routes.agent_inbox_service(ctx).get_batch(bid)
    assert b["status"] == "approved" and [j["request_id"] for j in b["jobs"]] == ["req-1", "req-2"]
    # 이벤트 → 상태 갱신 → 방송
    ctx.publish("queue_request_dequeued", {"request_id": "req-1"})
    assert b["jobs"][0]["status"] == "generating"
    ctx.result_store.items["req-1"] = SimpleNamespace(history_id="h1", filepath="C:/x.png", rel_path="__history_item__/h1",
                                                     generation_params={"input": "final", "negative_prompt": "n", "seed": 1},
                                                     prompt_context={})
    ctx.publish("generation_result_available", {"request_id": "req-1"})
    assert b["jobs"][0]["status"] == "done" and b["jobs"][0]["history_id"] == "h1" and b["jobs"][0]["final"]["prompt"] == "final"
    ctx.publish("generation_request_failed", {"request_id": "req-2", "message": "boom"})
    assert b["status"] == "done"
    assert any(x["type"] == "agent_inbox_done" for x in broadcasts)


def test_ws_verdict_reject_skip_refresh(tmp_path):
    app, ctx, broadcasts, started, broadcast_json, run_in_thread, start_runner = make_app(tmp_path)
    c = TestClient(app)
    bid = c.post("/api/agent-inbox/batches", json=batch_payload(2)).json()["batch_id"]
    jobs = c.get(f"/api/agent-inbox/batches/{bid}").json()["jobs"]
    ws = FakeWs()
    kw = dict(run_in_thread=run_in_thread, broadcast_json=broadcast_json, start_generation_runner=start_runner)
    asyncio.run(routes.handle_agent_inbox_command(ws, ctx, set(), {"type": "agent_inbox_verdict", "job_id": jobs[0]["job_id"], "decision": "accept", "note": "ok"}, **kw))
    assert routes.agent_inbox_service(ctx).find_job(jobs[0]["job_id"])[1]["verdict"]["decision"] == "accept"
    asyncio.run(routes.handle_agent_inbox_command(ws, ctx, set(), {"type": "agent_inbox_skip_job", "job_id": jobs[1]["job_id"]}, **kw))
    asyncio.run(routes.handle_agent_inbox_command(ws, ctx, set(), {"type": "agent_inbox_reject", "batch_id": bid, "note": "no"}, **kw))
    assert routes.agent_inbox_service(ctx).get_batch(bid)["status"] == "rejected"
    asyncio.run(routes.handle_agent_inbox_command(ws, ctx, set(), {"type": "agent_inbox_refresh"}, **kw))
    assert ws.sent[-1]["type"] == "agent_inbox_state"
    asyncio.run(routes.handle_agent_inbox_command(ws, ctx, set(), {"type": "agent_inbox_verdict", "job_id": "nope", "decision": "accept"}, **kw))
    assert ws.sent[-1]["type"] == "toast" and ws.sent[-1]["level"] == "error"
