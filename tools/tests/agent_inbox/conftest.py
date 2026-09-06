"""Agent Inbox 테스트 공통 — 포크 루트를 sys.path에 넣어 core/app 패키지를 import 가능하게 한다."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
