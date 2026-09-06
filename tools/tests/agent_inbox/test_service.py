import json

import pytest

from core.headless_agent_inbox_service import AgentInboxError, AgentInboxService


def payload(n=2):
    return {"source": "genit", "project": "p", "title": "t", "jobs": [
        {"key": f"E{i}", "prompt": f"p{i}", "negative": "", "params": {"seed": i, "width": 832, "height": 1216, "steps": 28}}
        for i in range(1, n + 1)]}


@pytest.fixture
def svc(tmp_path):
    return AgentInboxService(tmp_path / "inbox")


def test_submit_persists_and_lists(svc, tmp_path):
    batch, warnings = svc.submit(payload())
    assert batch["status"] == "pending" and len(batch["jobs"]) == 2
    assert all(j["job_id"] for j in batch["jobs"])
    files = list((tmp_path / "inbox").glob("*.json"))
    assert len(files) == 1 and json.loads(files[0].read_text("utf-8"))["batch_id"] == batch["batch_id"]
    assert svc.list_batches()[0]["job_count"] == 2
    assert svc.state_payload()["unread"] == 1


def test_reload_restores(tmp_path):
    a = AgentInboxService(tmp_path / "inbox"); b, _ = a.submit(payload())
    c = AgentInboxService(tmp_path / "inbox"); assert c.load_all() == 1
    assert c.get_batch(b["batch_id"])["jobs"][0]["key"] == "E1"


def test_load_all_purges_expired_terminal_batches(tmp_path):
    a = AgentInboxService(tmp_path / "inbox", retention_days=30)
    old, _ = a.submit(payload()); a.cancel_batch(old["batch_id"])
    fresh, _ = a.submit(payload())
    path = tmp_path / "inbox" / f"{old['batch_id']}.json"
    data = json.loads(path.read_text("utf-8")); data["updated_at"] = "2020-01-01T00:00:00"
    path.write_text(json.dumps(data), "utf-8")
    b = AgentInboxService(tmp_path / "inbox", retention_days=30)
    assert b.load_all() == 1 and not path.exists()
    assert b.get_batch(fresh["batch_id"])["status"] == "pending"


def test_cancel_only_pending(svc):
    b, _ = svc.submit(payload())
    svc.mark_batch_approved(b["batch_id"])
    with pytest.raises(AgentInboxError) as e:
        svc.cancel_batch(b["batch_id"])
    assert e.value.status == 409
    b2, _ = svc.submit(payload())
    assert svc.cancel_batch(b2["batch_id"])["status"] == "cancelled"
    with pytest.raises(AgentInboxError) as e404:
        svc.get_batch("nope")
    assert e404.value.status == 404


def test_reject_skip_and_approvable(svc):
    b, _ = svc.submit(payload(3))
    j1, j2, j3 = b["jobs"]
    svc.skip_job(j2["job_id"])
    keys = [j["key"] for j in svc.approvable_jobs(b["batch_id"])]
    assert keys == ["E1", "E3"]
    assert [j["key"] for j in svc.approvable_jobs(b["batch_id"], job_ids=[j3["job_id"]])] == ["E3"]
    r = svc.reject_batch(b["batch_id"], note="no")
    assert r["status"] == "rejected" and r["note"] == "no"


def test_lifecycle_via_events(svc):
    b, _ = svc.submit(payload(2))
    bid = b["batch_id"]; j1, j2 = b["jobs"]
    svc.mark_batch_approved(bid)
    svc.mark_job_queued(j1["job_id"], "req-1"); svc.mark_job_queued(j2["job_id"], "req-2")
    assert svc.get_batch(bid)["status"] == "approved"
    assert svc.handle_event("queue_request_dequeued", {"request_id": "req-1"}) == [bid]
    assert svc.get_batch(bid)["status"] == "generating"
    assert svc.get_batch(bid)["jobs"][0]["status"] == "generating"
    lookup = lambda rid: {"history_id": "h1", "file_path": "C:/out/1.png", "rel_path": "__history_item__/h1",
                          "prompt": "final p1", "negative": "", "params": {"seed": 1}} if rid == "req-1" else None
    svc.handle_event("generation_result_available", {"request_id": "req-1"}, history_lookup=lookup)
    j = svc.get_batch(bid)["jobs"][0]
    assert j["status"] == "done" and j["history_id"] == "h1" and j["final"]["prompt"] == "final p1"
    assert svc.handle_event("generation_request_failed", {"request_id": "req-2", "message": "boom"}) == [bid]
    b2 = svc.get_batch(bid)
    assert b2["jobs"][1]["status"] == "failed" and b2["jobs"][1]["error"] == "boom"
    assert b2["status"] == "done"
    notes = svc.pop_done_notifications()
    assert notes == [{"type": "agent_inbox_done", "batch_id": bid, "done": 1, "failed": 1, "skipped": 0}]
    assert svc.pop_done_notifications() == []
    assert svc.handle_event("queue_request_dequeued", {"request_id": "unknown"}) == []


def test_queue_removed_marks_skipped_and_cancel_generating(svc):
    b, _ = svc.submit(payload(2)); bid = b["batch_id"]; j1, j2 = b["jobs"]
    svc.mark_batch_approved(bid)
    svc.mark_job_queued(j1["job_id"], "r1"); svc.mark_job_queued(j2["job_id"], "r2")
    svc.handle_event("queue_request_dequeued", {"request_id": "r1"})
    assert svc.cancel_generating(bid) == ["r2"]
    svc.handle_event("queue_request_removed", {"request_id": "r2"})
    assert svc.get_batch(bid)["jobs"][1]["status"] == "skipped"
    assert svc.get_batch(bid)["status"] == "cancelled"


def test_verdict_and_review(svc):
    b, _ = svc.submit(payload(1)); j = b["jobs"][0]
    out = svc.set_verdict(j["job_id"], "accept", note="good")
    assert out["verdict"]["decision"] == "accept" and out["verdict"]["by"] == "user"
    with pytest.raises(AgentInboxError):
        svc.set_verdict(j["job_id"], "maybe")
    out = svc.set_agent_review(j["job_id"], {"safety": "pass", "style": "fail", "bogus": "x", "note": "n"})
    assert out["agent_review"]["safety"] == "pass" and "bogus" not in out["agent_review"]
    with pytest.raises(AgentInboxError):
        svc.set_agent_review(j["job_id"], {"safety": "maybe"})


def test_verdicts_done_notification_fires_once_when_all_done_jobs_are_judged(svc):
    b, _ = svc.submit(payload(2)); bid = b["batch_id"]; j1, j2 = b["jobs"]
    svc.mark_batch_approved(bid); svc.mark_job_queued(j1["job_id"], "r1"); svc.mark_job_queued(j2["job_id"], "r2")
    svc.handle_event("generation_result_available", {"request_id": "r1"}); svc.handle_event("generation_result_available", {"request_id": "r2"})
    assert svc.get_batch(bid)["status"] == "done"
    svc.pop_done_notifications()  # agent_inbox_done 소비
    assert svc.summary(svc.get_batch(bid))["verdicts_pending"] == 2
    svc.set_verdict(j1["job_id"], "accept")
    assert svc.pop_done_notifications() == []
    svc.set_verdict(j2["job_id"], "reject", note="x")
    notes = svc.pop_done_notifications()
    assert notes == [{"type": "agent_inbox_verdicts_done", "batch_id": bid, "title": "t", "accept": 1, "reject": 1, "redo": 0}]
    s = svc.summary(svc.get_batch(bid)); assert s["verdicts_pending"] == 0 and s["verdicts_done"] is True
    svc.set_verdict(j2["job_id"], "redo")  # 판정 변경은 다시 알리지 않는다
    assert svc.pop_done_notifications() == []


def test_results_payload_shape(svc):
    b, _ = svc.submit(payload(1)); bid = b["batch_id"]
    r = svc.results_payload(bid)
    assert r["batch_id"] == bid and r["jobs"][0]["key"] == "E1" and r["jobs"][0]["image_url"] == ""
