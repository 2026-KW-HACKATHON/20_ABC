"""오프라인 테스트 — 인터넷 없이 수집기 파서, AI 요청 형식, 그래프 덧입히기를 검사합니다.
실행: cd server && python -m pytest -q
"""
import json
import os
import tempfile

os.environ.setdefault("DATA_DIR", tempfile.mkdtemp())
os.environ.setdefault("ENABLE_SCHEDULER", "0")

from datetime import datetime  # noqa: E402

import httpx  # noqa: E402

from app.services import collect, geo  # noqa: E402
from app.services.cluster import hotspots  # noqa: E402

KW_LIST_HTML = """
<ul class="board-list">
 <li><div class="board-text"><a href="/ko/life/notice.jsp?BoardMode=view&DUID=53341&tpage=1&searchKey=1&searchVal=&srCategoryId=">
   [일반] [체육지원팀]광운대학교 축구부 2026 대학축구 경기 안내 <span>신규게시글</span></a>
   <p class="info">작성일 2026-09-15 | 수정일 2026-09-22 | 조회수 486</p></div></li>
 <li><div class="board-text"><a href="/ko/life/notice.jsp?BoardMode=view&DUID=53384&tpage=1">
   [국제학생] 2026년 하반기 현대건설 외국인 유학생 채용 공고 안내</a><p>작성일 2026-09-23</p></div></li>
 <li><div class="board-text"><a href="/ko/life/notice.jsp?BoardMode=view&DUID=53390&tpage=1">
   [일반] 동해문화예술관 가을 음악회 개최 안내</a><p>작성일 2026-09-20</p></div></li>
</ul>"""

KW_BODY_HTML = """<html><body><header>메뉴</header><div class="board-view-contents">
<p>○ 일시 : 10. 2.(금) 18:30</p><p>○ 장소 : 동해문화예술관 대극장</p><p>지역 주민 누구나 관람 가능합니다.</p>
</div><footer>광운대학교</footer></body></html>"""


def test_kw_list_parse():
    items = collect.parse_kw_list(KW_LIST_HTML)
    assert [i["duid"] for i in items] == ["53341", "53384", "53390"]
    assert items[0]["posted"] == "2026-09-15"
    assert items[0]["url"].startswith("https://www.kw.ac.kr/ko/life/notice.jsp?BoardMode=view&DUID=53341")
    assert "신규게시글" not in items[0]["title"]
    cands = [i for i in items if collect.kw_is_candidate(i["title"])]
    assert [c["duid"] for c in cands] == ["53341", "53390"]      # 채용 공고는 제외


def test_kw_body_and_heuristic():
    body = collect.parse_kw_body(KW_BODY_HTML)
    assert "메뉴" not in body and "대극장" in body
    info = collect.heuristic_event("[일반] 동해문화예술관 가을 음악회 개최 안내", body, "2026-09-20")
    assert info["start"] == "2026-10-02 18:30"
    assert "동해문화예술관" in info["place"]
    assert info["category"] == "culture"
    assert collect.kw_location(info["place"]) == collect.KW_BUILDINGS["동해문화예술관"]


def test_kw_fetch_with_mock_transport():
    def handler(req: httpx.Request):
        if req.url.params.get("BoardMode") == "list":
            return httpx.Response(200, text=KW_LIST_HTML)
        return httpx.Response(200, text=KW_BODY_HTML)
    with httpx.Client(transport=httpx.MockTransport(handler), base_url="https://www.kw.ac.kr") as c:
        out = collect.fetch_kw(c, pages=1)
    assert {o["source_id"] for o in out} == {"53341", "53390"}
    assert all(o["lat"] and o["start_at"] for o in out)


def test_seoul_rows():
    today = datetime(2026, 9, 24)
    rows = [
        {"CODENAME": "콘서트", "GUNAME": "노원구", "TITLE": "노원 가을 콘서트", "DATE": "2026-10-03~2026-10-03",
         "PLACE": "노원문화예술회관", "ORG_NAME": "노원문화재단", "USE_TRGT": "누구나", "USE_FEE": "무료",
         "STRTDATE": "2026-10-03 00:00:00.0", "END_DATE": "2026-10-03 00:00:00.0",
         "LAT": "127.0680", "LOT": "37.6530", "IS_FREE": "무료", "ORG_LINK": "https://example.org", "MAIN_IMG": ""},
        {"CODENAME": "교육/체험", "GUNAME": "성북구", "TITLE": "석계역 앞 체험", "STRTDATE": "2026-10-05 00:00:00.0",
         "END_DATE": "2026-10-05 00:00:00.0", "LAT": "37.6150", "LOT": "127.0660", "PLACE": "석계역"},
        {"CODENAME": "전시/미술", "GUNAME": "종로구", "TITLE": "먼 곳 전시", "STRTDATE": "2026-10-05 00:00:00.0",
         "END_DATE": "2026-10-05 00:00:00.0", "LAT": "37.57", "LOT": "126.98"},
        {"CODENAME": "전시/미술", "GUNAME": "노원구", "TITLE": "지난 전시", "STRTDATE": "2026-08-01 00:00:00.0",
         "END_DATE": "2026-08-10 00:00:00.0", "LAT": "37.65", "LOT": "127.06"},
    ]
    out = collect.parse_seoul_rows(rows, today)
    titles = [o["title"] for o in out]
    assert titles == ["노원 가을 콘서트", "석계역 앞 체험"]      # 노원구 + 반경 내 성북구, 지난 행사·먼 곳 제외
    assert abs(out[0]["lat"] - 37.653) < 1e-6 and abs(out[0]["lng"] - 127.068) < 1e-6   # 뒤바뀐 좌표 보정
    assert out[1]["category"] == "academic"


def test_ai_request_shape(monkeypatch):
    """Claude API 요청 형식과 응답 해석 (실제 호출 없이)."""
    import anthropic
    from app.services import ai
    try:                      # 최신 SDK는 httpx2, 이전 SDK는 httpx 를 씀
        import httpx2 as hx
    except ImportError:
        hx = httpx
    seen = {}

    def handler(req):
        seen["body"] = json.loads(req.content)
        return hx.Response(200, json={
            "id": "msg_1", "type": "message", "role": "assistant", "model": seen["body"]["model"],
            "content": [{"type": "tool_use", "id": "tu_1", "name": "report_classification",
                         "input": {"category": "road_damage", "confidence": 0.92, "summary": "보도블록이 깨져 있음",
                                   "severity": 2, "privacy": False}}],
            "stop_reason": "tool_use", "stop_sequence": None, "usage": {"input_tokens": 10, "output_tokens": 10}})
    client = anthropic.Anthropic(api_key="test", http_client=hx.Client(transport=hx.MockTransport(handler)))
    monkeypatch.setattr(ai, "_client", client)
    res = ai.classify_report(b"\xff\xd8fakejpeg", "보도블록")
    assert res == {"category": "road_damage", "confidence": 0.92, "summary": "보도블록이 깨져 있음", "severity": 2, "privacy": False}
    body = seen["body"]
    assert body["tool_choice"] == {"type": "tool", "name": "report_classification"}
    assert body["messages"][0]["content"][0]["type"] == "image"
    assert body["messages"][0]["content"][0]["source"]["media_type"] == "image/jpeg"


def test_graph_overlays():
    base = geo.base_graph()
    n0 = len(base["e"])
    # 광운대 안쪽 두 점을 잇는 새 길 + 쪽문(시간 제한) + 막힌 길
    g = geo.apply_overlays(base, [
        {"kind": "add", "coords": [[37.61950, 127.05950], [37.61985, 127.06020]], "open_hours": ""},
        {"kind": "gate", "coords": [[37.6180, 127.0600], [37.6182, 127.0603]], "open_hours": "06:00-23:00"},
        {"kind": "block", "coords": [[37.61905, 127.06090]], "open_hours": ""},
    ], [{"lat": 37.62026, "lng": 127.05857, "radius_m": 30}])
    assert len(g["e"]) > n0
    assert any(e[4] & geo.F_CUSTOM for e in g["e"])
    assert any(v == "06:00-23:00" for v in g["h"].values())
    assert any(e[4] & geo.F_CONSTR for e in g["e"])
    assert len(base["e"]) == n0                                   # 원본은 그대로


def test_osm_json_conversion():
    raw = {"elements": [
        {"type": "node", "id": 1, "lat": 37.61, "lon": 127.05}, {"type": "node", "id": 2, "lat": 37.62, "lon": 127.05},
        {"type": "node", "id": 3, "lat": 37.62, "lon": 127.06}, {"type": "node", "id": 4, "lat": 37.61, "lon": 127.06,
                                                                 "tags": {"shop": "convenience", "name": "CU"}},
        {"type": "way", "id": 10, "nodes": [1, 2, 3], "tags": {"highway": "footway"}},
        {"type": "way", "id": 11, "nodes": [3, 4, 1]},
        {"type": "relation", "id": 20, "tags": {"type": "boundary", "boundary": "administrative", "name": "월계1동"},
         "members": [{"type": "way", "ref": 10, "role": "outer"}, {"type": "way", "ref": 11, "role": "outer"}]},
    ]}
    gj = geo.osm_json_to_geojson(raw)
    types = sorted((f["geometry"]["type"], f["properties"].get("name", f["properties"].get("highway"))) for f in gj["features"])
    assert ("Polygon", "월계1동") in types and ("LineString", "footway") in types and ("Point", "CU") in types
    ring = next(f for f in gj["features"] if f["properties"].get("name") == "월계1동")["geometry"]["coordinates"][0]
    assert ring[0] == ring[-1] and len(ring) == 5


def test_hotspots():
    reps = [{"lat": 37.6200 + i * 0.00005, "lng": 127.0590, "category": "trash", "status": "received",
             "created_at": "2026-09-24T10:00"} for i in range(4)]
    reps.append({"lat": 37.6150, "lng": 127.0650, "category": "trash", "status": "received", "created_at": "2026-09-24T10:00"})
    hs = hotspots(reps)
    assert len(hs) == 1 and hs[0]["count"] == 4 and hs[0]["top_category"] == "trash"


def test_overlay_flags_apply_to_added_paths():
    base = geo.base_graph()
    add = [[37.61950, 127.05950], [37.61985, 127.06020]]
    g = geo.apply_overlays(base, [{"kind": "add", "coords": add, "open_hours": ""},
                                  {"kind": "block", "coords": add, "open_hours": ""}], [])
    custom = [e for e in g["e"] if e[4] & geo.F_CUSTOM]
    assert custom and all(e[4] & geo.F_BLOCK for e in custom)


def test_auth_tokens_and_private_reports():
    """탈퇴 후 같은 id 재사용 금지, 비밀번호 변경 시 예전 토큰 무효, 공개 목록에 신고 설명 비노출."""
    import io
    from fastapi.testclient import TestClient
    from PIL import Image
    from app.main import app
    with TestClient(app) as c:
        a = c.post("/api/auth/register", json={"username": "alice1", "password": "secret12", "nickname": "A"}).json()
        ta = a["token"]
        assert c.delete("/api/auth/me", headers={"Authorization": f"Bearer {ta}"}).status_code == 200
        c.post("/api/auth/register", json={"username": "bob1", "password": "secret12", "nickname": "B"})
        assert c.get("/api/auth/me", headers={"Authorization": f"Bearer {ta}"}).status_code == 401
        b = c.post("/api/auth/login", json={"username": "bob1", "password": "secret12"}).json()
        H = {"Authorization": f"Bearer {b['token']}"}
        new = c.patch("/api/auth/me", headers=H, json={"password": "newpass99"}).json()
        assert c.get("/api/auth/me", headers=H).status_code == 401
        H = {"Authorization": f"Bearer {new['token']}"}
        assert c.get("/api/auth/me", headers=H).status_code == 200
        buf = io.BytesIO(); Image.new("RGB", (64, 64)).save(buf, "JPEG")
        r = c.post("/api/reports", headers=H, files={"photo": ("a.jpg", buf.getvalue(), "image/jpeg")},
                   data={"lat": "37.62", "lng": "127.059", "category": "trash", "description": "101동 1203호 010-1234-5678"}).json()
        pub = c.get("/api/reports").json()
        assert all("010-1234" not in (x.get("summary") or "") for x in pub)
        assert c.get(f"/api/reports/{r['id']}/thumb").status_code == 403          # 서명 없으면 거부
        assert c.get(r["thumb_url"]).status_code == 200                            # 서명된 주소는 허용
        assert c.get("/api/events?when=month&year=10000&month=12").status_code == 422


def test_gemini_request_shape(monkeypatch):
    """Gemini REST 요청 형식(이미지·구조화 출력)과 응답 해석 (실제 호출 없이)."""
    from app.services import ai
    seen = {}

    def handler(req: httpx.Request):
        seen["url"] = str(req.url)
        seen["key"] = req.headers.get("x-goog-api-key")
        seen["body"] = json.loads(req.content)
        out = {"category": "illegal_parking", "confidence": 0.8, "summary": "보도 위 주차 차량", "severity": 2, "privacy": True}
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": json.dumps(out, ensure_ascii=False)}]},
                                                         "finishReason": "STOP"}]})
    monkeypatch.setattr(ai, "GEMINI_API_KEY", "g-test")
    monkeypatch.setattr(ai, "AI_PROVIDER", "")
    monkeypatch.setattr(ai, "_gemini_http", httpx.Client(transport=httpx.MockTransport(handler)))
    assert ai.provider() == "gemini"
    res = ai.classify_report(b"\xff\xd8fakejpeg")
    assert res["category"] == "illegal_parking" and res["privacy"] is True and res["severity"] == 2
    assert seen["key"] == "g-test" and ":generateContent" in seen["url"]
    body = seen["body"]
    assert body["contents"][0]["parts"][0]["inlineData"]["mimeType"] == "image/jpeg"
    sch = body["generationConfig"]["responseSchema"]
    assert sch["type"] == "OBJECT" and "enum" in sch["properties"]["category"]
    assert "enum" not in sch["properties"]["severity"]           # 숫자 enum 은 Gemini 가 지원하지 않아 제거


def test_gemini_quota(monkeypatch):
    from app.services import ai
    monkeypatch.setattr(ai, "GEMINI_API_KEY", "g-test")
    monkeypatch.setattr(ai, "_gemini_http", httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(429, json={}))))
    monkeypatch.setattr(ai.time, "sleep", lambda s: None)
    import pytest
    with pytest.raises(ai.QuotaError):
        ai.classify_report(b"x")


def test_walk_route_and_search(monkeypatch):
    """도보 경로·장소 검색 프록시 (외부 호출 없이). 검색은 월계동 범위만."""
    from fastapi.testclient import TestClient
    from app.main import app
    from app.routers import geoproxy
    seen = []

    def handler(req: httpx.Request):
        seen.append(str(req.url))
        if "/route/v1/" in req.url.path:
            return httpx.Response(200, json={"code": "Ok", "routes": [{"distance": 1234.5, "duration": 900,
                                  "geometry": {"coordinates": [[127.05, 37.62], [127.06, 37.63]]}}]})
        return httpx.Response(200, json=[{"name": "노원역", "display_name": "노원역, 상계동, 노원구, 서울", "lat": "37.655", "lon": "127.061"},
                                         {"name": "석계역", "display_name": "석계역, 월계동, 노원구, 서울", "lat": "37.6148", "lon": "127.0658"}])
    monkeypatch.setattr(geoproxy, "_http", httpx.Client(transport=httpx.MockTransport(handler)))
    monkeypatch.setattr(geoproxy, "_last_nominatim", 0.0)
    with TestClient(app) as c:
        r = c.get("/api/route/walk", params={"from": "37.62,127.05", "to": "37.63,127.06"}).json()
        assert r["distance"] == 1234.5 and r["coords"][0] == [37.62, 127.05]
        assert "/route/v1/driving/127.050000,37.620000;127.060000,37.630000" in seen[0]
        s = c.get("/api/geo/search", params={"q": "지하철역"}).json()
        assert [x["name"] for x in s] == ["석계역"]        # 서비스 범위(월계동) 밖인 노원역은 빠짐
        assert "bounded=1" in seen[-1]
        assert c.get("/api/route/walk", params={"from": "35.1,129.0", "to": "37.63,127.06"}).status_code == 400   # 30km 초과


def test_live_board(monkeypatch):
    """실시간 소식: 뉴스 RSS 해석, '월계' 기사만, 앱 소식과 비교해 가장 최근 것 하나."""
    from datetime import timedelta
    from email.utils import format_datetime
    from fastapi.testclient import TestClient
    from app.main import app
    from app.models import KST, now
    from app.routers import live
    t_new = format_datetime((now() - timedelta(minutes=30)).replace(tzinfo=KST))
    t_old = format_datetime((now() - timedelta(days=3)).replace(tzinfo=KST))
    rss = f"""<?xml version="1.0"?><rss><channel>
      <item><title>노원구 월계1동 경로당 개소 - 노원신문</title><link>https://news.example/a</link><pubDate>{t_new}</pubDate><source url="x">노원신문</source></item>
      <item><title>서울 날씨 맑음 - 어느신문</title><link>https://news.example/b</link><pubDate>{t_new}</pubDate><source url="x">어느신문</source></item>
      <item><title>월계동 축제 - 동북일보</title><link>https://news.example/c</link><pubDate>{t_old}</pubDate><source url="x">동북일보</source></item>
    </channel></rss>"""
    monkeypatch.setattr(live, "_http", httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, text=rss))))
    live._reset_cache_for_tests()
    with TestClient(app) as c:
        item = c.get("/api/live").json()["item"]
    assert item["kind"] == "news" and item["title"] == "노원구 월계1동 경로당 개소" and item["source"] == "노원신문"
    live._reset_cache_for_tests()


def test_kw_campus_places():
    """광운대 공지: 학교 밖 장소에 학교 좌표를 넣지 않음 + 예전 기록 바로잡기."""
    from app.db import SessionLocal
    from app.models import Event
    from app.services.collect import fix_kw_places, kw_location, kw_place_name
    assert kw_location("익산") == (None, None) and kw_place_name("익산") == "익산"
    assert kw_location("반포한강공원 달빛광장") == (None, None)
    assert kw_location("참빛관 101호")[0] is not None and kw_place_name("참빛관 101호") == "광운대학교 참빛관 101호"
    assert kw_location("")[0] is not None
    with SessionLocal() as db:
        db.add(Event(title="연합페스티벌 신규게시글", place_name="광운대학교 반포한강공원 달빛광장", lat=37.6197, lng=127.059,
                     source="kw", source_id="t-fix-1", status="approved"))
        db.add(Event(title="모의 IR", place_name="광운대학교 80", lat=37.6197, lng=127.059, source="kw", source_id="t-fix-2"))
        db.commit()
        assert fix_kw_places(db) >= 1
        a = db.query(Event).filter_by(source_id="t-fix-1").one()
        b = db.query(Event).filter_by(source_id="t-fix-2").one()
        assert a.title == "연합페스티벌" and a.place_name == "반포한강공원 달빛광장" and a.lat is None
        assert b.lat is not None and b.place_name == "광운대학교 80"
        assert fix_kw_places(db) == 0        # 두 번 실행해도 그대로
        db.delete(a); db.delete(b); db.commit()


def test_official_events(monkeypatch):
    """구청 주요행사계획: 번들 JSON 자동 등록(중복 없음), JSON 업로드는 승인, PDF는 AI로 뽑아 승인 대기."""
    import json as _json
    from fastapi.testclient import TestClient
    from app.main import app
    from app.db import SessionLocal
    from app.models import Event
    from app.services import ai, official
    with TestClient(app) as c:
        with SessionLocal() as db:
            n = db.query(Event).filter_by(source="nowon").count()
            assert n >= 70
            ev = db.query(Event).filter_by(source="nowon", source_id="2026-09:moonlight-market").one()
            assert ev.status == "approved" and ev.lat and "석계역" in ev.place_name and ev.start_at.hour == 14
            assert official.import_bundled(db)[0]["added"] == 0          # 다시 켜도 중복 등록 안 함
        from app.auth import hash_password, make_token
        from app.models import User
        with SessionLocal() as db:
            u = db.query(User).filter_by(username="offadmin").one_or_none()
            if not u:
                u = User(username="offadmin", nickname="관리", password_hash=hash_password("x-pass-123"), is_admin=True)
                db.add(u); db.commit()
            h = {"Authorization": f"Bearer {make_token(u)}"}
        doc = {"source": "nowon", "title": "테스트 10월", "month": "2026-10",
               "events": [{"key": "a", "title": "월계 가을 음악회", "category": "culture", "start": "2026-10-10 18:00",
                           "end": "2026-10-10 20:00", "place": "석계역 문화공원", "lat": 37.615, "lng": 127.064}]}
        r = c.post("/api/admin/official/upload", headers=h,
                   files={"file": ("oct.json", _json.dumps(doc).encode(), "application/json")}).json()
        assert r["added"] == 1 and r["status"] == "approved"
        # PDF → AI (가짜 응답)
        sent = {}
        def fake(system, content, tool, max_tokens=16000):
            sent["content"] = content
            return {"title": "노원구 2026년 11월 주요행사계획", "month": "2026-11", "events": [
                {"title": "월계동 김장나눔", "category": "community", "start": "2026-11-20", "end": "2026-11-20",
                 "time_text": "11월 20일", "place": "월계종합사회복지관", "description": "", "host": "", "target": "", "fee": ""}]}
        monkeypatch.setattr(ai, "enabled", lambda: True)
        monkeypatch.setattr(ai, "tool_call_long", fake)
        res = official.import_upload(SessionLocal(), "nov.pdf", b"%PDF-1.4 test")
        assert res["added"] == 1 and res["status"] == "pending"
        assert sent["content"][0]["type"] == "document" and sent["content"][0]["source"]["media_type"] == "application/pdf"
        with SessionLocal() as db:
            for e in db.query(Event).filter(Event.source_id.in_(["2026-10:a"])).all() + \
                     db.query(Event).filter(Event.title == "월계동 김장나눔").all():
                db.delete(e)
            db.commit()


def test_gemini_document_part(monkeypatch):
    """PDF(document) 블록이 Gemini inlineData로 전달되는지."""
    from app.services import ai
    captured = {}
    def handler(req):
        captured["body"] = _json_loads(req.content)
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": '{"title":"t","month":"2026-10","events":[]}'}]}}]})
    monkeypatch.setattr(ai, "_gemini_http", httpx.Client(transport=httpx.MockTransport(handler)))
    monkeypatch.setattr(ai, "provider", lambda: "gemini")
    out = ai.tool_call_long("sys", [{"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": "QUJD"}},
                                   {"type": "text", "text": "hi"}], {"name": "x", "input_schema": {"type": "object", "properties": {}}})
    assert out["month"] == "2026-10"
    part = captured["body"]["contents"][0]["parts"][0]
    assert part == {"inlineData": {"mimeType": "application/pdf", "data": "QUJD"}}


def _json_loads(b):
    import json as _json
    return _json.loads(b)


def test_basemap_service_area():
    """지도: 월계동 범위(a)와 월계1동 경계(b)를 따로 가짐. 2·3동 경계가 있으면 범위에 포함."""
    from app.services import geo
    sq = lambda la, ln, d: [[ln, la], [ln + d, la], [ln + d, la + d], [ln, la + d], [ln, la]]  # noqa: E731
    feats = [
        {"type": "Feature", "properties": {"boundary": "administrative", "name": "월계1동", "admin_level": "8"},
         "geometry": {"type": "Polygon", "coordinates": [sq(37.61, 127.05, 0.01)]}},
        {"type": "Feature", "properties": {"boundary": "administrative", "name": "월계2동", "admin_level": "8"},
         "geometry": {"type": "Polygon", "coordinates": [sq(37.62, 127.05, 0.01)]}},
        {"type": "Feature", "properties": {"boundary": "administrative", "name": "공릉1동", "admin_level": "8"},
         "geometry": {"type": "Polygon", "coordinates": [sq(37.62, 127.07, 0.01)]}},
    ]
    bm = geo.build_basemap(feats)
    assert bm["an"] == ["월계1동", "월계2동"] and len(bm["a"]) == 2
    assert bm["ab"] == [[37.61, 127.05], [37.63, 127.06]]
    assert geo._pip([37.615, 127.055], bm["b"]) and not geo._pip([37.625, 127.055], bm["b"])
