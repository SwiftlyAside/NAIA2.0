import pytest

from core.headless_agent_inbox_service import (
    MAX_JOBS_DEFAULT, MAX_JOBS_HARD, AgentInboxError, is_free_tier, validate_batch,
)


def job(key="E1", **over):
    base = {
        "key": key,
        "prompt": "1girl, amber eyes",
        "negative": "lowres",
        "params": {"seed": 52841, "width": 832, "height": 1216, "steps": 28, "cfg_scale": 7,
                   "sampler": "k_euler_ancestral", "model": "NAID5F"},
        "expect": {"character": "H", "emotion": "1"},
    }
    base.update(over)
    return base


def batch(jobs=None, **over):
    b = {"source": "genit", "project": "baeksaek-chohon", "title": "H 감정 9종", "jobs": jobs if jobs is not None else [job()]}
    b.update(over)
    return b


def test_valid_batch_normalizes_and_marks_pending():
    normalized, warnings = validate_batch(batch())
    assert normalized["source"] == "genit"
    assert normalized["jobs"][0]["status"] == "pending"
    assert normalized["jobs"][0]["params"]["width"] == 832
    assert warnings == []


def test_rejects_missing_jobs_and_bad_key():
    with pytest.raises(AgentInboxError) as e:
        validate_batch(batch(jobs=[]))
    assert e.value.status == 400
    with pytest.raises(AgentInboxError):
        validate_batch(batch(jobs=[job(key="../x")]))


def test_rejects_over_limit_and_clamps_hard_max():
    with pytest.raises(AgentInboxError):
        validate_batch(batch(jobs=[job(key=f"E{i}") for i in range(MAX_JOBS_DEFAULT + 1)]))
    with pytest.raises(AgentInboxError):
        validate_batch(batch(jobs=[job(key=f"E{i}") for i in range(MAX_JOBS_HARD + 1)]), max_jobs=999)


def test_rejects_non_integer_geometry_and_seed():
    with pytest.raises(AgentInboxError):
        validate_batch(batch(jobs=[job(params={"seed": "abc", "width": 832, "height": 1216, "steps": 28})]))
    with pytest.raises(AgentInboxError):
        validate_batch(batch(jobs=[job(params={"seed": 1, "width": "big", "height": 1216, "steps": 28})]))


def test_free_tier_warnings():
    assert is_free_tier({"steps": 28, "width": 832, "height": 1216})
    assert not is_free_tier({"steps": 29, "width": 832, "height": 1216})
    assert not is_free_tier({"steps": 28, "width": 1024, "height": 1216})
    _, warnings = validate_batch(batch(jobs=[job(params={"seed": 1, "width": 1024, "height": 1216, "steps": 28})]))
    assert warnings and "E1" in warnings[0]


def test_strips_credential_like_keys():
    normalized, _ = validate_batch(batch(jobs=[job(params={"seed": 1, "width": 832, "height": 1216, "steps": 28,
                                                          "credential": "x", "_secret": "y"})]))
    assert "credential" not in normalized["jobs"][0]["params"]
    assert "_secret" not in normalized["jobs"][0]["params"]
