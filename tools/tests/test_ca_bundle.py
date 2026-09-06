import ssl
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.backend.runtime.ca_bundle import BUNDLE_NAME, build_bundle, collect_system_roots, ensure_system_ca_bundle  # noqa: E402

def _fake_der(tag: bytes) -> bytes:
    # DER_cert_to_PEM_cert 는 바이트를 base64 로 감쌀 뿐 파싱하지 않는다 — 임의 바이트로 충분.
    return b"\x30\x82" + tag


def test_collect_dedups_and_filters_encoding():
    def enum(store):
        if store == "ROOT":
            return [(_fake_der(b"A"), "x509_asn", True), (_fake_der(b"A"), "x509_asn", True), (b"pkcs", "pkcs_7_asn", True)]
        if store == "CA":
            return [(_fake_der(b"B"), "x509_asn", True)]
        raise ValueError(store)
    pems = collect_system_roots(enum)
    assert len(pems) == 2 and all(p.startswith("-----BEGIN CERTIFICATE-----") for p in pems)


def test_build_bundle_appends_marker():
    b = build_bundle("CERTIFI\n", ["-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n"])
    assert b.startswith("CERTIFI") and "Windows system certificate store" in b and b.rstrip().endswith("END CERTIFICATE-----")


def test_ensure_writes_bundle_and_sets_env(tmp_path):
    certifi_file = tmp_path / "cacert.pem"; certifi_file.write_text("CERTIFI\n", encoding="utf-8")
    env = {}
    enum = lambda store: [(_fake_der(b"Z"), "x509_asn", True)] if store == "ROOT" else []
    out = ensure_system_ca_bundle(tmp_path / "cache", env=env, platform="win32", enum=enum, certifi_where=lambda: str(certifi_file))
    assert out == tmp_path / "cache" / BUNDLE_NAME and out.exists()
    assert env["REQUESTS_CA_BUNDLE"] == str(out) and env["SSL_CERT_FILE"] == str(out)
    # 같은 내용이면 다시 쓰지 않는다(mtime 유지)
    m = out.stat().st_mtime_ns
    ensure_system_ca_bundle(tmp_path / "cache", env={}, platform="win32", enum=enum, certifi_where=lambda: str(certifi_file))
    assert out.stat().st_mtime_ns == m


def test_ensure_respects_user_env_optout_and_platform(tmp_path):
    enum = lambda store: [(_fake_der(b"Z"), "x509_asn", True)]
    assert ensure_system_ca_bundle(tmp_path, env={"REQUESTS_CA_BUNDLE": "x.pem"}, platform="win32", enum=enum, certifi_where=lambda: "nope") is None
    assert ensure_system_ca_bundle(tmp_path, env={"NAIA_SYSTEM_CA": "0"}, platform="win32", enum=enum, certifi_where=lambda: "nope") is None
    assert ensure_system_ca_bundle(tmp_path, env={}, platform="linux", enum=enum, certifi_where=lambda: "nope") is None
    assert ensure_system_ca_bundle(tmp_path, env={}, platform="win32", enum=lambda s: [], certifi_where=lambda: "nope") is None
