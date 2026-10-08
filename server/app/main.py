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
from .routers import admin, auth, events, geoproxy, live, mapdata, me, media, push, tips
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
        from .services.collect import fix_kw_places
        from .services.official import import_bundled
        if fixed := fix_kw_places(db):
            log.info("광운대 공지 장소 %d건 바로잡음 (학교 밖 장소에 학교 좌표가 들어간 기록)", fixed)
        import_bundled(db)
        try:      # 좌표 없이 들어온 행사(구청 PDF 등)를 장소 이름으로 지도에 올림
            from .services import places
            places.fill_missing(db)
        except Exception as ex:
            log.warning("장소 위치 찾기 실패: %s", ex)
    geo.basemap()      # 지도 캐시 미리 만들기
    geo.base_graph()


def remind_favorites():
    """즐겨찾기한 행사가 곧 시작하면 앱 알림 — 몇 시간 전에 알릴지는 사용자 설정(fav_hours, 기본 24, 0이면 끔).
    시간 없이 날짜만 있는 행사(00:00)는 그날 오전 9시에 시작하는 것으로 계산."""
    from .services import prefs
    with SessionLocal() as db:
        t = now()
        hours = prefs.all_fav_hours(db)
        rows = db.execute(select(Favorite.user_id, Event).join(Event, Event.id == Favorite.event_id).where(
            Event.status == "approved", Event.start_at > t - timedelta(hours=9), Event.start_at <= t + timedelta(hours=49)))
        for uid, ev in rows:
            lead = hours.get(uid, prefs.DEFAULTS["fav_hours"])
            if not lead:
                continue
            all_day = ev.start_at.hour == 0 and ev.start_at.minute == 0
            start = ev.start_at.replace(hour=9) if all_day else ev.start_at
            if not (start - timedelta(hours=lead) <= t < start):
                continue
            left = max(1, round((start - t).total_seconds() / 3600))
            when = (f"{ev.start_at:%m월 %d일} 열려요" if all_day else f"{left}시간 뒤 시작해요 ({ev.start_at:%m월 %d일 %H:%M})")
            notify(db, uid, "event_soon", f"즐겨찾기한 행사가 곧 시작해요: {ev.title}",
                   f"{when} · {ev.place_name}", f"#/event/{ev.id}", f"soon:{ev.id}")
        db.commit()


def run_collect():
    from .services.collect import collect_all
    with SessionLocal() as db:
        log.info("행사 수집 결과: %s", collect_all(db))
        from .services import places
        places.fill_missing(db)
        if ai.enabled():     # 새로 들어온 행사의 빈칸을 AI로 채움 (한 번에 10개까지) + 검색용 연관 키워드
            from .services.eventfill import batch
            from .services.search import tag_batch
            log.info("빈칸 채우기: %s", batch(db, ("pending",), limit=10))
            log.info("검색 키워드: %s", tag_batch(db, limit=30))


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
        scheduler.add_job(remind_favorites, "interval", minutes=10, id="remind", max_instances=1, coalesce=True)
        scheduler.start()
    log.info("월계온 서버 시작 — AI 분류 %s, DB %s", ai.label() or "꺼짐 (GEMINI_API_KEY / ANTHROPIC_API_KEY 없음)",
             config.DATABASE_URL.split("://")[0])
    yield
    if scheduler:
        scheduler.shutdown(wait=False)


app = FastAPI(title="월계온 API", version="1.0.0", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

for r in (auth.router, events.router, tips.router, media.router, mapdata.router, me.router, admin.router, geoproxy.router, live.router, push.router):
    app.include_router(r)


@app.get("/api/config")
def client_config():
    """앱이 시작할 때 받는 설정 (위성지도 타일 주소 등)."""
    if config.VWORLD_KEY:
        sat = {"url": f"https://api.vworld.kr/req/wmts/1.0.0/{config.VWORLD_KEY}/Satellite/{{z}}/{{y}}/{{x}}.jpeg",
               "labels": f"https://api.vworld.kr/req/wmts/1.0.0/{config.VWORLD_KEY}/Hybrid/{{z}}/{{y}}/{{x}}.png",
               "maxNativeZoom": 19, "attribution": "위성영상 © 국토교통부 브이월드"}
    else:
        sat = {"url": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
               "labels": "", "maxNativeZoom": 19, "attribution": "위성영상 © Esri, Maxar, Earthstar Geographics"}
    return {"satellite": sat, "ai": ai.enabled()}


# ------------------------------------------------------------------ 안드로이드 앱(APK) 내려받기
# 만든 APK를 server/data/download/wolgyeon.apk 에 넣으면 웹에서 설치 안내가 뜸 (파일이 없으면 안내도 안 뜸)
APK_PATH = config.APK_PATH


@app.get("/api/app/apk")
def apk_info():
    if not APK_PATH.exists():
        return {"available": False}
    st = APK_PATH.stat()
    return {"available": True, "url": "/download/wolgyeon.apk", "size_mb": round(st.st_size / 1048576, 1),
            "updated": int(st.st_mtime)}


@app.get("/download/wolgyeon.apk", include_in_schema=False)
def apk_download():
    if not APK_PATH.exists():
        return JSONResponse({"detail": "아직 앱 파일이 올라오지 않았습니다."}, status_code=404)
    return FileResponse(APK_PATH, media_type="application/vnd.android.package-archive", filename="wolgyeon.apk",
                        headers={"Cache-Control": "no-cache"})


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
