"""Windows 시스템 인증서 저장소를 Python HTTPS(requests/certifi)에 신뢰시킨다.

Norton·기업 프록시처럼 TLS 를 자체 루트로 가로채는 환경에서는 Windows 는 그 루트를 신뢰하지만
`requests` 는 certifi 번들만 보므로 `CERTIFICATE_VERIFY_FAILED` 가 난다(2026-09-06 실측 — NovelAI 토큰
검증 실패). 여기서는 certifi + Windows ROOT/CA 저장소 인증서를 합친 번들을 캐시에 쓰고, 이 프로세스의
`REQUESTS_CA_BUNDLE`·`SSL_CERT_FILE` 로 지정한다. 의존성 없음(표준 `ssl.enum_certificates`).

- 이미 `REQUESTS_CA_BUNDLE`/`SSL_CERT_FILE` 이 있으면 손대지 않는다(사용자 설정 우선).
- `NAIA_SYSTEM_CA=0` 이면 끈다. Windows 가 아니면 no-op.
"""
from __future__ import annotations

import os
import ssl
import sys
from pathlib import Path
from typing import Callable, Iterable

ENV_KEYS = ("REQUESTS_CA_BUNDLE", "SSL_CERT_FILE")
BUNDLE_NAME = "ca-bundle-system.pem"


def _der_to_pem(der: bytes) -> str:
    return ssl.DER_cert_to_PEM_cert(der)


def collect_system_roots(enum: Callable[[str], Iterable[tuple]] = ssl.enum_certificates) -> list[str]:
    """Windows ROOT/CA 저장소의 X.509 인증서를 PEM 문자열 목록으로(중복 제거, 순서 유지)."""
    seen: set[bytes] = set()
    out: list[str] = []
    for store in ("ROOT", "CA"):
        try:
            entries = enum(store)
        except (OSError, ValueError, PermissionError):
            continue
        for der, encoding, _trust in entries:
            if encoding != "x509_asn" or der in seen:
                continue
            seen.add(der)
            out.append(_der_to_pem(der))
    return out


def build_bundle(certifi_pem: str, system_pems: Iterable[str]) -> str:
    parts = [certifi_pem.rstrip("\n"), "\n# --- Windows system certificate store (NAIA ca_bundle) ---\n"]
    parts.extend(p.strip() + "\n" for p in system_pems)
    return "\n".join(parts)


def ensure_system_ca_bundle(
    cache_dir: Path,
    *,
    env: dict = os.environ,
    platform: str = sys.platform,
    enum: Callable[[str], Iterable[tuple]] = ssl.enum_certificates,
    certifi_where: Callable[[], str] | None = None,
) -> Path | None:
    """번들을 만들고 env 에 지정한다. 만들지 않았으면 None."""
    if platform != "win32" or env.get("NAIA_SYSTEM_CA", "1").strip().lower() in {"0", "false", "off"}:
        return None
    if any(env.get(k) for k in ENV_KEYS):
        return None
    try:
        if certifi_where is None:
            import certifi
            where = certifi.where()
        else:
            where = certifi_where()
        certifi_pem = Path(where).read_text(encoding="utf-8")
    except Exception:
        return None
    system = collect_system_roots(enum)
    if not system:
        return None
    bundle = build_bundle(certifi_pem, system)
    target = Path(cache_dir) / BUNDLE_NAME
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists() or target.read_text(encoding="utf-8") != bundle:
            tmp = target.with_suffix(".pem.tmp")
            tmp.write_text(bundle, encoding="utf-8")
            os.replace(tmp, target)
    except OSError:
        return None
    for k in ENV_KEYS:
        env[k] = str(target)
    return target


def default_cache_dir(env: dict = os.environ) -> Path:
    root = env.get("NAIA_USER_DATA_DIR")
    if root:
        return Path(root) / "cache"
    import tempfile
    return Path(tempfile.gettempdir()) / "naia"
