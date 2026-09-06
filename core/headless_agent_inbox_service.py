"""Agent Inbox — 에이전트가 제출한 생성 배치의 검증·상태 기계·영속·결과 매칭.

FastAPI/starlette 를 import 하지 않는다(코어 경계). 라우트·WS 핸들러는
app/backend/server/agent_inbox_routes.py 가 이 서비스만 호출한다.
승인(큐 적재)은 이 모듈이 하지 않는다 — 사용자의 WS 클릭 경로(라우트 모듈)만 한다.
"""
from __future__ import annotations

import json
import os
import re
import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

KEY_RE = re.compile(r"^(calib/)?[A-Za-z0-9][A-Za-z0-9_-]*$")
MAX_JOBS_DEFAULT = 9
MAX_JOBS_HARD = 32
FREE_MAX_STEPS = 28
FREE_MAX_PIXELS = 1_048_576
BATCH_STATUSES = ("pending", "approved", "generating", "done", "cancelled", "rejected")
JOB_STATUSES = ("pending", "queued", "generating", "done", "failed", "skipped")
JOB_TERMINAL = ("done", "failed", "skipped")
VERDICTS = ("accept", "reject", "redo")
REVIEW_KEYS = ("safety", "style", "text", "anatomy", "speckle", "resolution")
REVIEW_VALUES = ("pass", "fail", "na")
INT_PARAMS = ("seed", "width", "height", "steps")
FLOAT_PARAMS = ("cfg_scale", "cfg_rescale")
STR_PARAMS = ("sampler", "scheduler", "model", "noise_schedule")


class AgentInboxError(Exception):
    def __init__(self, detail: str, status: int = 400):
        super().__init__(detail)
        self.detail = detail
        self.status = status


def _now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def is_free_tier(params: dict[str, Any]) -> bool:
    try:
        steps = int(params.get("steps") or 0)
        pixels = int(params.get("width") or 0) * int(params.get("height") or 0)
    except (TypeError, ValueError):
        return False
    return steps <= FREE_MAX_STEPS and pixels <= FREE_MAX_PIXELS


def _clean_params(raw: Any, key: str) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise AgentInboxError(f"{key}: params must be an object")
    out: dict[str, Any] = {}
    for name, value in raw.items():
        name = str(name)
        if name == "credential" or name.startswith("_"):
            continue
        if name in INT_PARAMS:
            bad = isinstance(value, bool) or not isinstance(value, (int, str)) or (
                isinstance(value, str) and not value.strip().lstrip("-").isdigit())
            if bad:
                raise AgentInboxError(f"{key}: params.{name} must be an integer")
            out[name] = int(value)
        elif name in FLOAT_PARAMS:
            try:
                out[name] = float(value)
            except (TypeError, ValueError):
                raise AgentInboxError(f"{key}: params.{name} must be a number")
        elif name in STR_PARAMS:
            out[name] = str(value)
        else:
            out[name] = value
    for required in ("width", "height", "steps"):
        if required not in out:
            raise AgentInboxError(f"{key}: params.{required} is required")
    return out


def _clean_expect(raw: Any) -> dict[str, str]:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise AgentInboxError("expect must be an object")
    return {k: str(v) for k, v in raw.items() if k in ("label", "character", "emotion", "note") and v is not None}


def validate_batch(payload: dict[str, Any], *, max_jobs: int = MAX_JOBS_DEFAULT) -> tuple[dict[str, Any], list[str]]:
    if not isinstance(payload, dict):
        raise AgentInboxError("batch must be an object")
    jobs_raw = payload.get("jobs")
    if not isinstance(jobs_raw, list) or not jobs_raw:
        raise AgentInboxError("jobs must be a non-empty list")
    limit = min(int(max_jobs), MAX_JOBS_HARD)
    if len(jobs_raw) > limit:
        raise AgentInboxError(f"too many jobs: {len(jobs_raw)} > {limit}")
    warnings: list[str] = []
    seen_keys: set[str] = set()
    jobs: list[dict[str, Any]] = []
    for raw in jobs_raw:
        if not isinstance(raw, dict):
            raise AgentInboxError("job must be an object")
        key = str(raw.get("key") or "")
        if not KEY_RE.match(key):
            raise AgentInboxError(f"invalid job key: {key!r}")
        if key in seen_keys:
            raise AgentInboxError(f"duplicate job key: {key}")
        seen_keys.add(key)
        prompt = str(raw.get("prompt") or "").strip()
        if not prompt:
            raise AgentInboxError(f"{key}: prompt is required")
        params = _clean_params(raw.get("params"), key)
        if not is_free_tier(params):
            warnings.append(f"{key}: 무료 조건 밖(steps>{FREE_MAX_STEPS} 또는 픽셀>{FREE_MAX_PIXELS}) — Anlas 과금")
        jobs.append({
            "key": key,
            "prompt": prompt,
            "negative": str(raw.get("negative") or ""),
            "params": params,
            "expect": _clean_expect(raw.get("expect")),
            "status": "pending",
        })
    batch = {
        "source": str(payload.get("source") or "agent")[:64],
        "project": str(payload.get("project") or "")[:128],
        "title": str(payload.get("title") or f"{len(jobs)} jobs")[:200],
        "note": str(payload.get("note") or "")[:2000],
        "jobs": jobs,
    }
    return batch, warnings


class AgentInboxService:
    def __init__(self, storage_dir: Path, *, max_jobs: int = MAX_JOBS_DEFAULT, retention_days: int = 30):
        self.storage_dir = Path(storage_dir)
        self.max_jobs = int(max_jobs)
        self.retention_days = int(retention_days)
        self._lock = threading.RLock()
        self._batches: dict[str, dict[str, Any]] = {}
        self._job_index: dict[str, str] = {}       # job_id -> batch_id
        self._request_index: dict[str, str] = {}   # request_id -> job_id
        self._done_notifications: list[dict[str, Any]] = []

    # ---------- 영속 ----------
    def load_all(self) -> int:
        """디스크의 배치를 전부 복원한다. 종료 상태(done/cancelled/rejected)가 retention_days 를
        넘긴 파일은 삭제하고 복원하지 않는다(스펙 §4.1 보관 정리)."""
        cutoff = datetime.now().timestamp() - self.retention_days * 86400
        with self._lock:
            self._batches.clear(); self._job_index.clear(); self._request_index.clear()
            if not self.storage_dir.exists():
                return 0
            for path in sorted(self.storage_dir.glob("*.json")):
                try:
                    batch = json.loads(path.read_text(encoding="utf-8"))
                except Exception:
                    continue
                if not (isinstance(batch, dict) and batch.get("batch_id")):
                    continue
                stamp = str(batch.get("updated_at") or batch.get("created_at") or "")
                try:
                    updated = datetime.fromisoformat(stamp).timestamp()
                except ValueError:
                    updated = path.stat().st_mtime
                if batch.get("status") in ("done", "cancelled", "rejected") and updated < cutoff:
                    try:
                        path.unlink()
                    except OSError:
                        pass
                    continue
                self._index(batch)
            return len(self._batches)

    def _index(self, batch: dict[str, Any]) -> None:
        self._batches[batch["batch_id"]] = batch
        for job in batch.get("jobs", []):
            self._job_index[job["job_id"]] = batch["batch_id"]
            if job.get("request_id"):
                self._request_index[job["request_id"]] = job["job_id"]

    def _save(self, batch: dict[str, Any]) -> None:
        batch["updated_at"] = _now_iso()
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        target = self.storage_dir / f"{batch['batch_id']}.json"
        tmp = target.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(batch, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, target)

    # ---------- 조회 ----------
    def get_batch(self, batch_id: str) -> dict[str, Any]:
        batch = self._batches.get(str(batch_id or ""))
        if batch is None:
            raise AgentInboxError("batch not found", 404)
        return batch

    def find_job(self, job_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
        batch_id = self._job_index.get(str(job_id or ""))
        if batch_id is None:
            raise AgentInboxError("job not found", 404)
        batch = self._batches[batch_id]
        job = next(j for j in batch["jobs"] if j["job_id"] == job_id)
        return batch, job

    def summary(self, batch: dict[str, Any]) -> dict[str, Any]:
        counts = {s: 0 for s in JOB_STATUSES}
        for job in batch["jobs"]:
            counts[job["status"]] = counts.get(job["status"], 0) + 1
        return {
            "batch_id": batch["batch_id"], "source": batch["source"], "project": batch["project"],
            "title": batch["title"], "status": batch["status"], "created_at": batch["created_at"],
            "updated_at": batch.get("updated_at"), "job_count": len(batch["jobs"]), "counts": counts,
            "paid_jobs": sum(1 for j in batch["jobs"] if not is_free_tier(j["params"])),
            "note": batch.get("note", ""),
        }

    def list_batches(self, status: str | None = None, source: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        with self._lock:
            rows = [b for b in self._batches.values()
                    if (not status or b["status"] == status) and (not source or b["source"] == source)]
            rows.sort(key=lambda b: b["created_at"], reverse=True)
            return [self.summary(b) for b in rows[: max(1, int(limit))]]

    def state_payload(self) -> dict[str, Any]:
        with self._lock:
            summaries = self.list_batches(limit=50)
            by_created = sorted(self._batches.values(), key=lambda b: b["created_at"], reverse=True)
            active = next((b for b in by_created if b["status"] in ("approved", "generating")), None)
            if active is None:
                by_updated = sorted(self._batches.values(), key=lambda b: b.get("updated_at") or "", reverse=True)
                active = next((b for b in by_updated if b["status"] == "done"), None)
            return {"type": "agent_inbox_state", "batches": summaries, "active": active,
                    "unread": sum(1 for b in self._batches.values() if b["status"] == "pending")}

    def results_payload(self, batch_id: str) -> dict[str, Any]:
        with self._lock:
            batch = self.get_batch(batch_id)
            return {"batch_id": batch["batch_id"], "status": batch["status"], "jobs": [{
                "job_id": j["job_id"], "key": j["key"], "status": j["status"], "request_id": j.get("request_id", ""),
                "history_id": j.get("history_id", ""), "file_path": j.get("file_path", ""),
                "rel_path": j.get("rel_path", ""),
                "image_url": f"/api/history/image/{j['history_id']}" if j.get("history_id") else "",
                "final": j.get("final"), "verdict": j.get("verdict"), "agent_review": j.get("agent_review"),
                "error": j.get("error", ""),
            } for j in batch["jobs"]]}

    def pop_done_notifications(self) -> list[dict[str, Any]]:
        with self._lock:
            out, self._done_notifications = self._done_notifications, []
            return out

    # ---------- 변경 ----------
    def submit(self, payload: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
        batch, warnings = validate_batch(payload, max_jobs=self.max_jobs)
        with self._lock:
            batch["batch_id"] = uuid.uuid4().hex
            batch["status"] = "pending"
            batch["created_at"] = _now_iso()
            for job in batch["jobs"]:
                job["job_id"] = uuid.uuid4().hex
            self._index(batch)
            self._save(batch)
            return batch, warnings

    def cancel_batch(self, batch_id: str) -> dict[str, Any]:
        with self._lock:
            batch = self.get_batch(batch_id)
            if batch["status"] != "pending":
                raise AgentInboxError(f"batch is {batch['status']}, only pending can be cancelled", 409)
            batch["status"] = "cancelled"
            for job in batch["jobs"]:
                if job["status"] == "pending":
                    job["status"] = "skipped"
            self._save(batch)
            return batch

    def reject_batch(self, batch_id: str, note: str = "") -> dict[str, Any]:
        with self._lock:
            batch = self.get_batch(batch_id)
            if batch["status"] != "pending":
                raise AgentInboxError(f"batch is {batch['status']}", 409)
            batch["status"] = "rejected"
            batch["note"] = str(note or "")
            for job in batch["jobs"]:
                job["status"] = "skipped"
            self._save(batch)
            return batch

    def skip_job(self, job_id: str) -> dict[str, Any]:
        with self._lock:
            batch, job = self.find_job(job_id)
            if job["status"] != "pending":
                raise AgentInboxError(f"job is {job['status']}", 409)
            job["status"] = "skipped"
            self._rollup(batch)
            self._save(batch)
            return job

    def set_verdict(self, job_id: str, decision: str, note: str = "", by: str = "user") -> dict[str, Any]:
        if decision not in VERDICTS:
            raise AgentInboxError(f"decision must be one of {VERDICTS}")
        with self._lock:
            batch, job = self.find_job(job_id)
            job["verdict"] = {"decision": decision, "note": str(note or ""),
                              "by": by if by in ("user", "agent") else "user", "at": _now_iso()}
            self._save(batch)
            return job

    def set_agent_review(self, job_id: str, review: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(review, dict):
            raise AgentInboxError("review must be an object")
        clean: dict[str, Any] = {}
        for key, value in review.items():
            if key in REVIEW_KEYS:
                if value not in REVIEW_VALUES:
                    raise AgentInboxError(f"{key} must be one of {REVIEW_VALUES}")
                clean[key] = value
            elif key == "note":
                clean["note"] = str(value or "")[:2000]
        with self._lock:
            batch, job = self.find_job(job_id)
            merged = dict(job.get("agent_review") or {})
            merged.update(clean)
            merged["at"] = _now_iso()
            job["agent_review"] = merged
            self._save(batch)
            return job

    def approvable_jobs(self, batch_id: str, job_ids: list[str] | None = None) -> list[dict[str, Any]]:
        with self._lock:
            batch = self.get_batch(batch_id)
            wanted = set(job_ids) if job_ids else None
            return [j for j in batch["jobs"] if j["status"] == "pending" and (wanted is None or j["job_id"] in wanted)]

    def mark_batch_approved(self, batch_id: str) -> dict[str, Any]:
        with self._lock:
            batch = self.get_batch(batch_id)
            if batch["status"] != "pending":
                raise AgentInboxError(f"batch is {batch['status']}", 409)
            batch["status"] = "approved"
            batch["approved_at"] = _now_iso()
            self._save(batch)
            return batch

    def mark_job_queued(self, job_id: str, request_id: str) -> dict[str, Any]:
        with self._lock:
            batch, job = self.find_job(job_id)
            job["status"] = "queued"
            job["request_id"] = str(request_id)
            self._request_index[job["request_id"]] = job_id
            self._save(batch)
            return job

    def set_file_path(self, job_id: str, file_path: str) -> dict[str, Any]:
        """자동 저장이 늦게 끝난 잡의 파일 경로를 뒤늦게 기록한다(결과 조회 시 라우트가 호출)."""
        with self._lock:
            batch, job = self.find_job(job_id)
            job["file_path"] = str(file_path or "")
            self._save(batch)
            return job

    def mark_job_failed(self, job_id: str, reason: str) -> dict[str, Any]:
        with self._lock:
            batch, job = self.find_job(job_id)
            job["status"] = "failed"
            job["error"] = str(reason or "")[:500]
            self._rollup(batch)
            self._save(batch)
            return job

    def cancel_generating(self, batch_id: str) -> list[str]:
        """진행 중 배치를 즉시 cancelled 로 확정하고 남은 queued 잡의 request_id 목록을 돌려준다.
        큐 제거는 호출자(라우트)가 하고, 제거 이벤트(queue_request_removed)가 돌아오면 skipped 로 바뀐다.
        생성 중인 1장은 끝까지 가서 done 으로 기록된다."""
        with self._lock:
            batch = self.get_batch(batch_id)
            if batch["status"] not in ("approved", "generating"):
                raise AgentInboxError(f"batch is {batch['status']}", 409)
            batch["status"] = "cancelled"
            batch["finished_at"] = _now_iso()
            self._save(batch)
            return [j["request_id"] for j in batch["jobs"] if j["status"] == "queued" and j.get("request_id")]

    # ---------- 이벤트 ----------
    def handle_event(self, name: str, payload: dict[str, Any], *,
                     history_lookup: Callable[[str], dict[str, Any] | None] | None = None) -> list[str]:
        if name == "queue_cleared":
            with self._lock:
                changed = []
                for batch in self._batches.values():
                    if any(j["status"] == "queued" for j in batch["jobs"]):
                        for j in batch["jobs"]:
                            if j["status"] == "queued":
                                j["status"] = "skipped"
                        self._rollup(batch); self._save(batch); changed.append(batch["batch_id"])
                return changed
        request_id = str((payload or {}).get("request_id") or "")
        with self._lock:
            job_id = self._request_index.get(request_id)
            if not job_id:
                return []
            batch, job = self.find_job(job_id)
            if name == "queue_request_dequeued" and job["status"] == "queued":
                job["status"] = "generating"
            elif name == "generation_result_available":
                job["status"] = "done"
                found = history_lookup(request_id) if history_lookup else None
                if found:
                    job["history_id"] = str(found.get("history_id") or "")
                    job["file_path"] = str(found.get("file_path") or "")
                    job["rel_path"] = str(found.get("rel_path") or "")
                    job["final"] = {"prompt": str(found.get("prompt") or ""), "negative": str(found.get("negative") or ""),
                                    "params": found.get("params") or {}}
            elif name == "generation_request_failed":
                job["status"] = "failed"
                job["error"] = str((payload or {}).get("message") or "")[:500]
            elif name == "queue_request_removed" and job["status"] in ("queued", "pending"):
                job["status"] = "skipped"
            else:
                return []
            self._rollup(batch)
            self._save(batch)
            return [batch["batch_id"]]

    def _rollup(self, batch: dict[str, Any]) -> None:
        if batch["status"] in ("pending", "cancelled", "rejected", "done"):
            return
        statuses = [j["status"] for j in batch["jobs"]]
        if any(s == "generating" for s in statuses):
            batch["status"] = "generating"
        if all(s in JOB_TERMINAL for s in statuses):
            batch["status"] = "done"
            batch["finished_at"] = _now_iso()
            if not batch.get("done_notified"):
                batch["done_notified"] = True
                self._done_notifications.append({
                    "type": "agent_inbox_done", "batch_id": batch["batch_id"],
                    "done": statuses.count("done"), "failed": statuses.count("failed"), "skipped": statuses.count("skipped"),
                })
