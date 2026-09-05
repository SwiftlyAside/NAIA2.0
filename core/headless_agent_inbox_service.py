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
