"""환경 설정 — 모든 값은 환경변수(.env)로 바꿀 수 있습니다."""
import os
import secrets
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
SERVER_DIR = APP_DIR.parent
SEED_DIR = APP_DIR / "seed"


def _load_dotenv() -> None:
    """server/.env 가 있으면 읽어서 환경변수로 등록 (이미 설정된 값은 유지)."""
    env_file = SERVER_DIR / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip().strip('"').strip("'")
        if v:                                   # 빈 값(KEY=)은 무시하고 기본값을 씀
            os.environ.setdefault(k.strip(), v)


_load_dotenv()


def env(name: str, default: str = "") -> str:
    """환경변수를 읽되, 비어 있으면 기본값을 씀 (Render 등에서 빈 값으로 둔 경우 대비)."""
    v = os.getenv(name)
    return v.strip() if v and v.strip() else default


WEB_DIR = Path(env("WEB_DIR", SERVER_DIR.parent / "web")).resolve()
DATA_DIR = Path(env("DATA_DIR", SERVER_DIR / "data")).resolve()
APK_PATH = DATA_DIR / "download" / "wolgyeon.apk"     # 안드로이드 앱 파일 (관리자 대시보드에서 올림)
DATA_DIR.mkdir(parents=True, exist_ok=True)

DATABASE_URL = env("DATABASE_URL", f"sqlite:///{DATA_DIR / 'wolgyeon.db'}")
# Render/Heroku 형식(postgres://)을 SQLAlchemy 형식으로 보정
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+psycopg://", 1)
elif DATABASE_URL.startswith("postgresql://"):
    DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+psycopg://", 1)


def _secret_key() -> str:
    key = env("SECRET_KEY")
    if key:
        return key
    f = DATA_DIR / "secret.key"
    if f.exists():
        return f.read_text().strip()
    key = secrets.token_urlsafe(48)
    f.write_text(key)
    return key


SECRET_KEY = _secret_key()
TOKEN_DAYS = int(env("TOKEN_DAYS", "30"))

ADMIN_USERNAME = env("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = env("ADMIN_PASSWORD", "")  # 비어 있으면 관리자 자동 생성 안 함

AI_PROVIDER = env("AI_PROVIDER", "").strip().lower()   # gemini / anthropic / 비우면 자동
GEMINI_API_KEY = env("GEMINI_API_KEY", "")
GEMINI_MODEL = env("GEMINI_MODEL", "gemini-3.5-flash-lite")
ANTHROPIC_API_KEY = env("ANTHROPIC_API_KEY", "")
ANTHROPIC_MODEL = env("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001")

SEOUL_API_KEY = env("SEOUL_API_KEY", "sample")  # sample 키는 5건까지만 조회됨
COLLECT_INTERVAL_HOURS = float(env("COLLECT_INTERVAL_HOURS", "6"))
ENABLE_SCHEDULER = env("ENABLE_SCHEDULER", "1") not in ("0", "false", "False")
COLLECT_ON_START = env("COLLECT_ON_START", "0") in ("1", "true", "True")

MAX_UPLOAD_MB = float(env("MAX_UPLOAD_MB", "8"))

# 월계1동 밖 일반 도보 길찾기 · 장소 검색
ROUTING_URL = env("ROUTING_URL", "https://routing.openstreetmap.de/routed-foot")
NOMINATIM_URL = env("NOMINATIM_URL", "https://nominatim.openstreetmap.org")
KAKAO_REST_KEY = env("KAKAO_REST_KEY", "")   # 있으면 장소 검색을 카카오로 (국내 상호 검색이 훨씬 정확)
VWORLD_KEY = env("VWORLD_KEY", "")          # 브이월드(국토부) 위성영상 키 — 없으면 Esri 위성영상 사용

# 월계1동 중심 (행사 수집 시 거리 필터 기준)
CENTER = (37.6205, 127.0585)
NEARBY_KM = float(env("NEARBY_KM", "2.5"))
