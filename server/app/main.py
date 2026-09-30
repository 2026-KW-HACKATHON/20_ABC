"""월계온(Wolgye-ON) 서버 진입점.

실행:  uvicorn app.main:app --host 0.0.0.0 --port 8000
"""
import logging
import os
from contextlib import asynccontextmanager
from datetime import timedelta

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select

from . import config
from .auth import hash_password
from .db import Base, SessionLocal, engine
from .models import Event, Favorite, User, now
from .routers import admin, auth, events, mapdata, me, reports
from .services import ai, geo
from .services.notify import notify

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("wolgyeon")


def bootstrap():
    Base.metadata.create_all(engine)
    with SessionLocal() as db:
        if config.ADMIN_PASSWORD:
            u = db.scalar(select(User).where(User.username == config.ADMIN_USERNAME.lower()))
            if not u:
                db.add(User(username=config.ADMIN_USERNAME.lower(), nickname="관리자",
                            password_hash=hash_password(config.ADMIN_PASSWORD), is_admin=True))
                log.info("관리자 계정 생성: %s", config.ADMIN_USERNAME)
            elif not u.is_admin:
                u.is_admin = True
        if os.getenv("SEED_SAMPLE", "1") == "1" and not db.scalar(select(Event.id).limit(1)):
            t = now().replace(hour=0, minute=0, second=0, microsecond=0)
            db.add_all([
                Event(title="(예시) 석계역 문화공원 주말 버스킹", category="culture", start_at=t + timedelta(days=3, hours=14),
                      end_at=t + timedelta(days=3, hours=16), place_name="석계역문화공원", lat=37.61516, lng=127.06424,
                      description="관리자 화면에서 지우거나 고쳐 쓰는 예시 행사입니다.", host="월계온", status="approved",
                      source="manual", source_id="sample1"),
                Event(title="(예시) 광운대 80주년기념관 공개 특강", category="academic", start_at=t + timedelta(days=5, hours=15),
                      place_name="광운대학교 80주년기념관", lat=37.62008, lng=127.05879,
                      description="관리자 화면에서 지우거나 고쳐 쓰는 예시 행사입니다.", host="광운대학교", status="approved",
                      source="manual", source_id="sample2"),
            ])
        db.commit()
    geo.basemap()      # 지도 캐시 미리 만들기
    geo.base_graph()


def remind_favorites():
    """즐겨찾기한 행사가 24시간 안에 시작하면 앱 내 알림."""
    with SessionLocal() as db:
        t = now()
        rows = db.execute(select(Favorite.user_id, Event).join(Event, Event.id == Favorite.event_id).where(
            Event.status == "approved", Event.start_at > t, Event.start_at <= t + timedelta(hours=24)))
        for uid, ev in rows:
            notify(db, uid, "event_soon", f"곧 시작해요: {ev.title}",
                   f"{ev.start_at:%m월 %d일 %H:%M} · {ev.place_name}", f"#/event/{ev.id}", f"soon:{ev.id}")
        db.commit()


def run_collect():
    from .services.collect import collect_all
    with SessionLocal() as db:
        log.info("행사 수집 결과: %s", collect_all(db))


scheduler = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global scheduler
    bootstrap()
    if config.ENABLE_SCHEDULER:
        from apscheduler.schedulers.background import BackgroundScheduler
        scheduler = BackgroundScheduler(timezone="Asia/Seoul")
        extra = {"next_run_time": now() + timedelta(seconds=20)} if config.COLLECT_ON_START else {}
        # next_run_time=None 을 넘기면 작업이 멈춘 상태로 등록되므로, 필요할 때만 넘긴다
        scheduler.add_job(run_collect, "interval", hours=config.COLLECT_INTERVAL_HOURS, id="collect",
                          max_instances=1, coalesce=True, **extra)
        scheduler.add_job(remind_favorites, "interval", minutes=30, id="remind", max_instances=1, coalesce=True)
        scheduler.start()
    log.info("월계온 서버 시작 — AI 분류 %s, DB %s", ai.label() or "꺼짐 (GEMINI_API_KEY / ANTHROPIC_API_KEY 없음)",
             config.DATABASE_URL.split("://")[0])
    yield
    if scheduler:
        scheduler.shutdown(wait=False)


app = FastAPI(title="월계온 API", version="1.0.0", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

for r in (auth.router, events.router, reports.router, mapdata.router, me.router, admin.router):
    app.include_router(r)


@app.get("/api/health")
def health():
    return {"ok": True, "ai": ai.label() or False, "time": now().isoformat(timespec="seconds")}


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception):
    log.exception("처리 중 오류: %s %s", request.method, request.url.path)
    return JSONResponse({"detail": "서버에서 오류가 났습니다. 잠시 후 다시 시도해주세요."}, status_code=500)


# ------------------------------------------------------------------ 웹앱 정적 파일
if config.WEB_DIR.exists():
    @app.get("/admin", include_in_schema=False)
    @app.get("/admin/", include_in_schema=False)
    def admin_page():
        return FileResponse(config.WEB_DIR / "admin" / "index.html", headers={"Cache-Control": "no-cache"})

    @app.get("/sw.js", include_in_schema=False)
    def sw():
        return FileResponse(config.WEB_DIR / "sw.js", media_type="application/javascript",
                            headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"})

    app.mount("/", StaticFiles(directory=config.WEB_DIR, html=True), name="web")
