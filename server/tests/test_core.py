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
            "content": [{"type": "tool_use", "id": "tu_1", "name": "poster_event",
                         "input": {"is_event": True, "title": "월계 가을 작은음악회", "category": "culture", "start": "2026-10-10 18:00",
                                   "end": "", "time_text": "10월 10일(토) 오후 6시", "place": "월계1동 주민센터",
                                   "host": "월계1동 주민자치회", "fee": "무료", "summary": "동네 음악회"}}],
            "stop_reason": "tool_use", "stop_sequence": None, "usage": {"input_tokens": 10, "output_tokens": 10}})
    client = anthropic.Anthropic(api_key="test", http_client=hx.Client(transport=hx.MockTransport(handler)))
    monkeypatch.setattr(ai, "_client", client)
    res = ai.extract_poster(b"\xff\xd8fakejpeg", "2026-09-28")
    assert res["title"] == "월계 가을 작은음악회" and res["start"] == "2026-10-10 18:00" and res["is_event"] is True
    body = seen["body"]
    assert body["tool_choice"] == {"type": "tool", "name": "poster_event"}
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


def test_overlay_flags_apply_to_added_paths():
    base = geo.base_graph()
    add = [[37.61950, 127.05950], [37.61985, 127.06020]]
    g = geo.apply_overlays(base, [{"kind": "add", "coords": add, "open_hours": ""},
                                  {"kind": "block", "coords": add, "open_hours": ""}], [])
    custom = [e for e in g["e"] if e[4] & geo.F_CUSTOM]
    assert custom and all(e[4] & geo.F_BLOCK for e in custom)


def test_auth_tokens():
    """탈퇴 후 같은 id 재사용 금지, 비밀번호 변경 시 예전 토큰 무효."""
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
        assert c.get("/api/events?when=month&year=10000&month=12").status_code == 422


def test_gemini_request_shape(monkeypatch):
    """Gemini REST 요청 형식(포스터 이미지·구조화 출력)과 응답 해석 (실제 호출 없이)."""
    from app.services import ai
    seen = {}

    def handler(req: httpx.Request):
        seen["url"] = str(req.url)
        seen["key"] = req.headers.get("x-goog-api-key")
        seen["body"] = json.loads(req.content)
        out = {"is_event": True, "title": "경로당 바자회", "category": "community", "start": "2026-10-03", "end": "",
               "time_text": "10월 3일", "place": "월계1동 경로당", "host": "", "fee": "", "summary": "바자회"}
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": json.dumps(out, ensure_ascii=False)}]},
                                                         "finishReason": "STOP"}]})
    monkeypatch.setattr(ai, "GEMINI_API_KEY", "g-test")
    monkeypatch.setattr(ai, "AI_PROVIDER", "")
    monkeypatch.setattr(ai, "_gemini_http", httpx.Client(transport=httpx.MockTransport(handler)))
    assert ai.provider() == "gemini"
    res = ai.extract_poster(b"\xff\xd8fakejpeg", "2026-09-28")
    assert res["title"] == "경로당 바자회" and res["category"] == "community"
    assert seen["key"] == "g-test" and ":generateContent" in seen["url"]
    body = seen["body"]
    assert body["contents"][0]["parts"][0]["inlineData"]["mimeType"] == "image/jpeg"
    sch = body["generationConfig"]["responseSchema"]
    assert sch["type"] == "OBJECT" and "enum" in sch["properties"]["category"] and sch["properties"]["is_event"]["type"] == "BOOLEAN"


def test_gemini_quota(monkeypatch):
    from app.services import ai
    monkeypatch.setattr(ai, "GEMINI_API_KEY", "g-test")
    monkeypatch.setattr(ai, "_gemini_http", httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(429, json={}))))
    monkeypatch.setattr(ai.time, "sleep", lambda s: None)
    import pytest
    with pytest.raises(ai.QuotaError):
        ai.extract_poster(b"x", "2026-09-28")


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


def test_live_board():
    """실시간 보드: 뉴스 없이, 7일 안에 열리는 월계동 행사만 무작위로."""
    from datetime import timedelta
    from fastapi.testclient import TestClient
    from app.db import SessionLocal
    from app.main import app
    from app.models import Event, now
    t = now()
    with TestClient(app) as c, SessionLocal() as db:
        db.add_all([
            Event(title="라이브 테스트 곧", category="culture", start_at=t + timedelta(days=2), lat=37.61515, lng=127.06419,
                  status="approved", source="manual", source_id="live1"),
            Event(title="라이브 테스트 먼 미래", category="culture", start_at=t + timedelta(days=20), lat=37.61515, lng=127.06419,
                  status="approved", source="manual", source_id="live2"),
            Event(title="라이브 테스트 동 밖", category="culture", start_at=t + timedelta(days=1), lat=37.6545, lng=127.0567,
                  status="approved", source="manual", source_id="live3"),
        ])
        db.commit()
        items = c.get("/api/live").json()["items"]
        titles = [x["title"] for x in items]
        assert "라이브 테스트 곧" in titles and "라이브 테스트 먼 미래" not in titles and "라이브 테스트 동 밖" not in titles
        assert all(x.get("kind") for x in items) and next(x for x in items if x["title"] == "라이브 테스트 곧")["when_label"] == "2일 뒤"
        for e in db.query(Event).filter(Event.source_id.in_(["live1", "live2", "live3"])).all():
            db.delete(e)
        db.commit()


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
            assert official.import_bundled(db) == []                      # 서버를 다시 켜도 다시 넣지 않음
            assert official.import_bundled(db, force=True)[0]["added"] == 0   # 강제로 넣어도 중복 없음
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
    assert len(bm["ao"]) == 1                                         # 붙어 있는 두 동 → 바깥 경계 하나
    lats = [q[0] for q in bm["ao"][0]]
    assert min(lats) < 37.6105 and max(lats) > 37.6295


def _user_headers(c, username):
    r = c.post("/api/auth/register", json={"username": username, "password": "secret12", "nickname": username})
    if r.status_code != 200:
        r = c.post("/api/auth/login", json={"username": username, "password": "secret12"})
    return {"Authorization": f"Bearer {r.json()['token']}"}


def test_event_tips(monkeypatch):
    """주민 행사 제보: 로그인 필수, 월계동 밖 거부, 포스터는 승인 전 비공개, 승인·반려 시 제보자 알림, 대기 제보 제한."""
    import io
    from fastapi.testclient import TestClient
    from PIL import Image
    from app.auth import hash_password, make_token
    from app.db import SessionLocal
    from app.main import app
    from app.models import Event, Notification, User
    from app.routers import tips
    with TestClient(app) as c:
        form = {"title": "월계1동 경로당 가을 바자회", "category": "community", "start_date": "2026-10-10", "start_time": "10:00",
                "end_time": "15:00", "place_name": "월계1동 경로당", "lat": "37.61665", "lng": "127.06439",
                "description": "직접 만든 반찬과 옷 판매", "contact": "010-0000-0000"}
        assert c.post("/api/tips", data=form).status_code == 401                              # 로그인 필요
        H = _user_headers(c, "tipper1")
        bad = dict(form, lat="37.6545", lng="127.0567")                                       # 노원구청 (월계동 밖)
        assert c.post("/api/tips", headers=H, data=bad).status_code == 400
        buf = io.BytesIO(); Image.new("RGB", (80, 120), "orange").save(buf, "JPEG")
        t = c.post("/api/tips", headers=H, data=form, files={"photo": ("p.jpg", buf.getvalue(), "image/jpeg")}).json()
        assert t["status"] == "pending" and t["end_at"] == "2026-10-10T15:00" and t["image_url"]
        assert c.get(t["image_url"]).status_code == 403                                       # 승인 전 포스터 비공개
        assert all(e["id"] != t["id"] for e in c.get("/api/events?when=all").json())         # 승인 전엔 목록에 없음
        mine = c.get("/api/tips/mine", headers=H).json()
        assert mine[0]["id"] == t["id"] and mine[0]["status_label"] == "확인 중"
        with SessionLocal() as db:
            admin = db.query(User).filter_by(username="tipadmin").one_or_none()
            if not admin:
                admin = User(username="tipadmin", nickname="관리", password_hash=hash_password("x-pass-123"), is_admin=True)
                db.add(admin); db.commit()
            AH = {"Authorization": f"Bearer {make_token(admin)}"}
            ev = db.get(Event, t["id"])
            assert "010-0000-0000" in ev.ai_note and ev.contact == ""                          # 연락처는 관리자 메모에만
        adm = [e for e in c.get("/api/admin/events?status=pending", headers=AH).json() if e["id"] == t["id"]][0]
        assert c.get(adm["poster_admin_url"]).status_code == 200                              # 관리자는 서명된 주소로 봄
        rp = c.patch(f"/api/admin/events/{t['id']}", headers=AH, json={"title": t["title"], "status": "approved"})
        assert rp.status_code == 200, rp.text
        assert c.get(t["image_url"]).status_code == 200                                       # 승인 후 공개
        with SessionLocal() as db:
            uid = db.query(User).filter_by(username="tipper1").one().id
            n = db.query(Notification).filter_by(user_id=uid, kind="tip_result").all()
            assert len(n) == 1 and n[0].link == f"#/event/{t['id']}"
        # 대기 제보는 5개까지
        for i in range(5):
            c.post("/api/tips", headers=H, data=dict(form, title=f"테스트 제보 {i}"))
        assert c.post("/api/tips", headers=H, data=dict(form, title="여섯 번째")).status_code == 429
        pend = [x for x in c.get("/api/tips/mine", headers=H).json() if x["status"] == "pending"]
        assert c.delete(f"/api/tips/{pend[0]['id']}", headers=H).json()["ok"]
        # 같은 장소 다른 행사
        sp = c.get(f"/api/events/{t['id']}/same-place").json()
        assert "current" in sp and "past" in sp
        with SessionLocal() as db:
            for e in db.query(Event).filter(Event.source == "tip").all():
                tips.delete_poster(e); db.delete(e)
            db.commit()


def test_event_kinds():
    """세부 종류(아이콘·필터): 제목·설명 키워드, 없으면 큰 분류 기본값."""
    from app.services.kinds import event_kind
    assert event_kind("찾아가는 오케스트라", "", "culture") == "music"
    assert event_kind("제3회 석계역 달빛야시장", "", "culture") == "market"
    assert event_kind("노원구청장배 댄스스포츠대회", "", "community") == "sports"
    assert event_kind("제18회 전국 발달장애인 댄스경연대회", "", "culture") == "show"
    assert event_kind("노원미술협회 제30회 정기전", "", "culture") == "exhibit"
    assert event_kind("2026학년도 모의 IR 경진대회", "", "academic") == "contest"
    assert event_kind("이름만 있는 행사", "", "academic") == "class"


def test_ai_fill(monkeypatch):
    """AI 빈칸 채우기: 원문이 있을 때만 날짜·장소를 채우고, 없으면 소개만."""
    from datetime import datetime
    from app.models import Event
    from app.services import ai, eventfill
    fake = {"description": "동네 주민이 함께하는 가을 음악회입니다.", "start": "2026-10-10 18:00", "end": "2026-10-10 20:00",
            "time_text": "10월 10일 오후 6시", "place": "월계1동 주민센터", "host": "주민자치회", "fee": "무료", "target": "누구나"}
    monkeypatch.setattr(ai, "fill_event", lambda known, src, today: dict(fake))
    e = Event(title="가을 음악회", category="culture", description="", time_text="", place_name="", host="", fee="",
              start_at=datetime(2026, 10, 10, 18, 0), url="")
    sug = eventfill.suggest(e, src="")                               # 원문 없음 → 소개만
    assert set(sug) == {"description"} and "대상: 누구나" in sug["description"]
    sug = eventfill.suggest(e, src="10월 10일 18:00~20:00 월계1동 주민센터 무료")
    assert sug["end_at"] == datetime(2026, 10, 10, 20, 0) and sug["place_name"] == "월계1동 주민센터" and "start_at" not in sug
    eventfill.apply(e, sug)
    assert e.fee == "무료" and "AI로 채움" in e.ai_note


def test_review_media():
    """후기 사진·영상: 본인만 첨부, 4개 제한, 공개 주소로 보기, 후기 지우면 파일도 지움."""
    import io
    from datetime import timedelta
    from fastapi.testclient import TestClient
    from PIL import Image
    from app.db import SessionLocal
    from app.main import app
    from app.models import Event, now
    from app.routers.media import MEDIA_DIR
    with TestClient(app) as c:
        with SessionLocal() as db:
            ev = Event(title="후기 테스트 행사", category="culture", start_at=now() - timedelta(days=1), lat=37.615, lng=127.064,
                       status="approved", source="manual", source_id="rv-media")
            db.add(ev); db.commit(); eid = ev.id
        H = _user_headers(c, "reviewer1")
        H2 = _user_headers(c, "reviewer2")
        rid = c.post(f"/api/events/{eid}/reviews", headers=H, json={"rating": 5, "body": "정말 좋았어요"}).json()["id"]
        buf = io.BytesIO(); Image.new("RGB", (200, 100), "red").save(buf, "PNG")
        files = [("files", ("a.png", buf.getvalue(), "image/png")), ("files", ("v.mp4", b"\x00\x00\x00\x18ftypmp42", "video/mp4"))]
        assert c.post(f"/api/reviews/{rid}/media", headers=H2, files=files).status_code == 403
        up = c.post(f"/api/reviews/{rid}/media", headers=H, files=files).json()
        assert [m["kind"] for m in up] == ["image", "video"]
        assert c.get(up[0]["url"]).headers["content-type"] == "image/jpeg"
        assert c.get(up[1]["url"]).status_code == 200
        too_many = [("files", (f"{i}.png", buf.getvalue(), "image/png")) for i in range(3)]
        assert c.post(f"/api/reviews/{rid}/media", headers=H, files=too_many).status_code == 400
        detail = c.get(f"/api/events/{eid}").json()
        assert len(detail["reviews"][0]["media"]) == 2 and detail["kind"]
        names = [m["url"].rsplit("/", 1)[1] for m in up]
        assert c.delete(f"/api/events/reviews/{rid}", headers=H).json()["ok"]
        assert not any((MEDIA_DIR / n).exists() for n in names)
        with SessionLocal() as db:
            db.delete(db.get(Event, eid)); db.commit()


def test_painted_stairs_overlay():
    """칠하기 제보: 칠한 범위를 지나는 경로 구간에 계단 표시, 밖의 구간은 그대로."""
    base = geo.base_graph()
    n = base["n"]
    e0 = base["e"][len(base["e"]) // 2]
    a, b = n[e0[0]], n[e0[1]]
    mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    stroke = [[mid[0] - 0.00002, mid[1] - 0.00002], [mid[0] + 0.00002, mid[1] + 0.00002]]
    g = geo.apply_overlays(base, [{"kind": "stairs", "coords": [], "strokes": [stroke], "brush_m": 6, "open_hours": ""}], [])
    flagged = [e for e in g["e"] if e[4] & geo.F_STAIRS and not (e0 is None)]
    assert any(e[0] == e0[0] and e[1] == e0[1] for e in flagged)
    assert len(flagged) < len(g["e"]) * 0.01                          # 칠한 곳 근처만


def test_painted_path_api():
    """칠하기 제보 API: 계단·가파른 길만 허용, 저장·조회 형식."""
    from fastapi.testclient import TestClient
    from app.main import app
    with TestClient(app) as c:
        H = _user_headers(c, "painter1")
        stroke = [[37.6195, 127.0595], [37.61955, 127.0596], [37.6196, 127.0597]]
        r = c.post("/api/map/paths", headers=H, json={"kind": "stairs", "strokes": [stroke], "brush_m": 10})
        assert r.status_code == 200, r.text
        out = r.json()
        assert out["strokes"] == [stroke] and out["brush_m"] == 10 and out["coords"] == []
        assert c.post("/api/map/paths", headers=H, json={"kind": "add", "strokes": [stroke]}).status_code == 400
        assert c.post("/api/map/paths", headers=H, json={"kind": "steep", "strokes": [[]]}).status_code == 400
        mine = c.get("/api/map/paths/mine", headers=H).json()
        assert mine[0]["kind"] == "stairs" and mine[0]["strokes"]


def test_event_reset():
    """행사 초기화: '초기화' 확인 필요, 범위별 삭제, 후기·즐겨찾기도 함께."""
    from datetime import timedelta
    from fastapi.testclient import TestClient
    from app.auth import hash_password, make_token
    from app.db import SessionLocal
    from app.main import app
    from app.models import Event, Favorite, Review, User, now
    with TestClient(app) as c:
        with SessionLocal() as db:
            admin = db.query(User).filter_by(username="resetadmin").one_or_none()
            if not admin:
                admin = User(username="resetadmin", nickname="관리", password_hash=hash_password("x-pass-123"), is_admin=True)
                db.add(admin); db.commit()
            AH = {"Authorization": f"Bearer {make_token(admin)}"}
            keep = Event(title="직접 등록 행사", category="culture", source="manual", source_id="rs-keep", status="approved",
                         start_at=now() - timedelta(days=1), lat=37.615, lng=127.064)
            gone = Event(title="수집 행사", category="culture", source="seoul", source_id="rs-gone", status="approved",
                         start_at=now() - timedelta(days=1), lat=37.615, lng=127.064)
            db.add_all([keep, gone]); db.commit()
            db.add(Favorite(user_id=admin.id, event_id=gone.id)); db.add(Review(event_id=gone.id, user_id=admin.id, rating=5, body="좋아요"))
            db.commit(); gid, kid = gone.id, keep.id
        assert c.post("/api/admin/events/reset", headers=AH, json={"scope": "collected", "confirm": "네"}).status_code == 400
        r = c.post("/api/admin/events/reset", headers=AH, json={"scope": "collected", "confirm": "초기화"}).json()
        assert r["deleted"] >= 1 and r["reviews"] >= 1
        with SessionLocal() as db:
            assert db.get(Event, gid) is None and db.get(Event, kid) is not None
            assert db.query(Favorite).filter_by(event_id=gid).count() == 0 and db.query(Review).filter_by(event_id=gid).count() == 0
            assert db.query(Event).filter(Event.source == "nowon").count() == 0
        re = c.post("/api/admin/official/reimport", headers=AH).json()
        assert re["added"] >= 70                                      # 구청 자료 다시 넣기
        with SessionLocal() as db:
            db.delete(db.get(Event, kid)); db.commit()


def test_elevation_grid(monkeypatch):
    """고도: 격자(약 90m)로 받아 보간 — 요청 수가 적고, 받은 고도가 경사도에 반영됨."""
    from app.services import osm_update
    calls = []

    def handler(req):
        lats = [float(x) for x in req.url.params["latitude"].split(",")]
        calls.append(len(lats))
        return httpx.Response(200, json={"elevation": [(la - 37.6) * 10000 for la in lats]})   # 북쪽으로 갈수록 높아짐
    real = httpx.Client
    monkeypatch.setattr(osm_update.httpx, "Client", lambda **kw: real(transport=httpx.MockTransport(handler)))
    res = osm_update.fetch_elevation(pause=0)
    assert res["missing"] == 0 and res["nodes_with_elevation"] > 1000
    assert len(calls) <= 40 and max(calls) <= 100                    # 무료 한도 안에서
    assert res["graph"]["graded"] > 1000
    assert osm_update.fetch_elevation(pause=0)["fetched_now"] == 0   # 두 번째는 저장한 격자를 씀
    (osm_update.DATA_DIR / "elevation.json").unlink(missing_ok=True)
    (osm_update.DATA_DIR / "elevation_grid.json").unlink(missing_ok=True)
    from app.services import geo
    geo.reset_cache()


def test_place_locate():
    """장소 이름만 있는 행사 → 지도 이름·별칭으로 위치 찾기 (오인 방지 포함)."""
    from app.services import places
    hit = places.locate("월계도서관 4층 달빛소리홀")
    assert hit and hit[2] == "월계문화정보도서관" and geo.area_contains(hit[0], hit[1])
    assert places.locate("광운대링크")[2] == "광운대학교"
    assert places.locate("마들스포츠타운 테니스장") is None or "테니스장" != places.locate("마들스포츠타운 테니스장")[2]
    assert places.locate("롯데월드 어드벤처 (송파구 올림픽로 240)") is None
    assert places.locate("") is None


def test_area_filter_and_search():
    """지도·달력·목록(area=1)은 월계동 안 행사만, 검색은 밖 행사도 (in_area=False) + 연관어로 찾기."""
    from datetime import timedelta
    from fastapi.testclient import TestClient
    from app.db import SessionLocal
    from app.main import app
    from app.models import Event, now
    with TestClient(app) as c:
        t = now() + timedelta(days=2)
        with SessionLocal() as db:
            evs = [
                Event(title="월계 그림책 원화 전시", category="culture", source="manual", source_id="af-in", status="approved",
                      start_at=t, lat=37.62863, lng=127.0561, description="작가의 원화를 함께 봐요"),
                Event(title="상계동 가을 음악회", category="culture", source="manual", source_id="af-out", status="approved",
                      start_at=t, lat=37.6545, lng=127.0610, description="오케스트라 공연"),
                Event(title="어딘가의 오케스트라 콘서트", category="culture", source="manual", source_id="af-noloc", status="approved",
                      start_at=t, description="클래식"),
            ]
            db.add_all(evs); db.commit()
            ids = [e.id for e in evs]
        try:
            area = {e["id"] for e in c.get("/api/events?area=1").json()}
            allv = {e["id"] for e in c.get("/api/events").json()}
            assert ids[0] in area and ids[1] not in area and ids[2] not in area
            assert set(ids) <= allv
            m = c.get(f"/api/events?area=1&when=month&year={t.year}&month={t.month}").json()
            assert ids[0] in {e["id"] for e in m} and ids[1] not in {e["id"] for e in m}
            # '아이' → 이름·소개에 없어도 '그림책'으로 연결
            r = c.get("/api/events/search", params={"q": "아이"}).json()
            hit = {e["id"]: e for e in r["items"]}
            assert ids[0] in hit and hit[ids[0]]["in_area"] is True and "그림책" in " ".join(hit[ids[0]]["reasons"])
            assert "어린이" in r["related"]
            # '음악' → 밖 행사·위치 없는 행사도 검색에는 나옴
            r = c.get("/api/events/search", params={"q": "음악"}).json()
            hit = {e["id"]: e for e in r["items"]}
            assert ids[1] in hit and hit[ids[1]]["in_area"] is False
            assert ids[2] in hit                                     # '콘서트·오케스트라' → 음악 종류
        finally:
            with SessionLocal() as db:
                for i in ids:
                    db.delete(db.get(Event, i))
                db.commit()


def test_calendar_notes():
    """달력 날짜별 메모: 로그인 필요, 저장·월별 조회·빈 글로 지우기, 남의 메모는 안 보임."""
    from fastapi.testclient import TestClient
    from app.main import app
    with TestClient(app) as c:
        assert c.put("/api/me/notes/2026-10-12", json={"text": "x"}).status_code == 401
        h1, h2 = _user_headers(c, "noteuser1"), _user_headers(c, "noteuser2")
        assert c.put("/api/me/notes/2026-10-12", headers=h1, json={"text": "  도서관 반납  "}).json()["text"] == "도서관 반납"
        c.put("/api/me/notes/2026-10-20", headers=h1, json={"text": "축제"})
        c.put("/api/me/notes/2026-11-01", headers=h1, json={"text": "다음 달"})
        assert c.put("/api/me/notes/2026-1-1", headers=h1, json={"text": "x"}).status_code == 400
        got = c.get("/api/me/notes?year=2026&month=10", headers=h1).json()
        assert got == {"2026-10-12": "도서관 반납", "2026-10-20": "축제"}
        assert c.get("/api/me/notes?year=2026&month=10", headers=h2).json() == {}
        c.put("/api/me/notes/2026-10-20", headers=h1, json={"text": ""})
        assert "2026-10-20" not in c.get("/api/me/notes?year=2026&month=10", headers=h1).json()


def test_admin_bulk_and_locate():
    """관리자: 위치 없는 행사도 승인 가능(검색 전용), 장소 이름으로 위치 찾기, 여러 개 한 번에 승인."""
    from fastapi.testclient import TestClient
    from app.auth import hash_password, make_token
    from app.db import SessionLocal
    from app.main import app
    from app.models import Event, User
    with TestClient(app) as c:
        with SessionLocal() as db:
            admin = db.query(User).filter_by(username="bulkadmin").one_or_none()
            if not admin:
                admin = User(username="bulkadmin", nickname="관리", password_hash=hash_password("x-pass-123"), is_admin=True)
                db.add(admin); db.commit()
            AH = {"Authorization": f"Bearer {make_token(admin)}"}
            a = Event(title="월계도서관 북토크", place_name="월계도서관 4층 달빛소리홀", source="nowon", source_id="bk-a", status="pending")
            b = Event(title="먼 곳 행사", place_name="충북 제천시 체육관", source="nowon", source_id="bk-b", status="pending")
            db.add_all([a, b]); db.commit()
            ia, ib = a.id, b.id
        try:
            r = c.post("/api/admin/events/locate", headers=AH).json()
            assert r["found"] >= 1
            rows = {e["id"]: e for e in c.get("/api/admin/events?status=pending&area=in", headers=AH).json()}
            assert ia in rows and ib not in rows
            assert c.post("/api/admin/events/bulk", headers=AH, json={"ids": [ia, ib], "status": "approved"}).json()["changed"] == 2
            with SessionLocal() as db:
                assert db.get(Event, ia).status == "approved" and db.get(Event, ib).status == "approved"
                assert db.get(Event, ib).lat is None                 # 위치 없음 → 검색에서만
        finally:
            with SessionLocal() as db:
                for i in (ia, ib):
                    db.delete(db.get(Event, i))
                db.commit()


def test_admin_approve_pending():
    """관리자: 승인 대기 행사 한 번에 공개 (월계동 안만 / 전체)."""
    from fastapi.testclient import TestClient
    from app.auth import hash_password, make_token
    from app.db import SessionLocal
    from app.main import app
    from app.models import Event, User
    with TestClient(app) as c:
        with SessionLocal() as db:
            db.query(Event).filter(Event.status == "pending").update({"status": "rejected"})
            admin = db.query(User).filter_by(username="apadmin").one_or_none()
            if not admin:
                admin = User(username="apadmin", nickname="관리", password_hash=hash_password("x-pass-123"), is_admin=True)
                db.add(admin)
            db.commit()
            AH = {"Authorization": f"Bearer {make_token(admin)}"}
            a = Event(title="안 행사", place_name="월계도서관 2층", source="nowon", source_id="ap-a", status="pending")
            b = Event(title="밖 행사", place_name="노원구청 대강당", source="nowon", source_id="ap-b", status="pending")
            db.add_all([a, b]); db.commit()
            ia, ib = a.id, b.id
        try:
            r = c.post("/api/admin/events/approve-pending", headers=AH, json={"area": "in"}).json()
            assert r["approved"] == 1 and r["inside"] == 1
            r = c.post("/api/admin/events/approve-pending", headers=AH, json={"area": "all"}).json()
            assert r["approved"] == 1
            with SessionLocal() as db:
                assert db.get(Event, ia).status == db.get(Event, ib).status == "approved"
        finally:
            with SessionLocal() as db:
                for i in (ia, ib):
                    db.delete(db.get(Event, i))
                db.commit()


def test_push_prefs_feed_broadcast():
    """알림 설정(즐겨찾기 알림 시간), 앱 알림 묶음(feed), 관리자 일괄 알림(추천·직접·즐겨찾기)."""
    from datetime import timedelta
    from fastapi.testclient import TestClient
    from app.auth import hash_password, make_token
    from app.db import SessionLocal
    from app.main import app, remind_favorites
    from app.models import Broadcast, Event, Favorite, Notification, User, now
    with TestClient(app) as c:
        h = _user_headers(c, "pushuser1")
        assert c.get("/api/me/prefs", headers=h).json()["fav_hours"] == 24
        assert c.put("/api/me/prefs", headers=h, json={"fav_hours": 5}).status_code == 400
        assert c.put("/api/me/prefs", headers=h, json={"fav_hours": 2, "promo": False}).json() == {"fav_hours": 2, "promo": False}
        with SessionLocal() as db:
            uid = db.query(User).filter_by(username="pushuser1").one().id
            admin = db.query(User).filter_by(username="bcadmin").one_or_none()
            if not admin:
                admin = User(username="bcadmin", nickname="관리", password_hash=hash_password("x-pass-123"), is_admin=True)
                db.add(admin); db.commit()
            AH = {"Authorization": f"Bearer {make_token(admin)}"}
            soon = Event(title="곧 하는 행사", category="culture", source="manual", source_id="push-a", status="approved",
                         start_at=(now() + timedelta(minutes=90)).replace(second=0, microsecond=0), lat=37.62863, lng=127.0561)
            later = Event(title="나중 행사", category="culture", source="manual", source_id="push-b", status="approved",
                          start_at=(now() + timedelta(hours=5)).replace(second=0, microsecond=0), lat=37.62863, lng=127.0561)
            db.add_all([soon, later]); db.commit()
            db.add_all([Favorite(user_id=uid, event_id=soon.id), Favorite(user_id=uid, event_id=later.id)]); db.commit()
            ids = (soon.id, later.id)
        try:
            # 처음 연결(-1): 지난 것은 안 주고 마지막 id만
            f0 = c.get("/api/app/feed", headers=h).json()
            assert f0["broadcasts"] == [] and f0["notifications"] == []
            # 즐겨찾기 알림: 2시간 전 설정 → 90분 뒤 행사만
            remind_favorites()
            with SessionLocal() as db:
                refs = {n.ref for n in db.query(Notification).filter_by(user_id=uid, kind="event_soon")}
            assert f"soon:{ids[0]}" in refs and f"soon:{ids[1]}" not in refs
            f1 = c.get(f"/api/app/feed?after_bc={f0['latest_bc']}&after_nt={f0['latest_nt']}", headers=h).json()
            assert any("곧 하는 행사" in n["title"] for n in f1["notifications"])
            # 관리자: 행사 추천(문구 자동) · 직접 쓰기 · 즐겨찾기 일괄
            meta = c.get("/api/admin/broadcast/meta", headers=AH).json()
            ev = next(e for e in meta["events"] if e["id"] == ids[1])
            assert "어떠세요" in ev["msg_title"]
            r = c.post("/api/admin/broadcast", headers=AH, json={"mode": "event", "event_id": ids[1]}).json()
            assert r["sent"] >= 2
            assert c.post("/api/admin/broadcast", headers=AH, json={"mode": "custom", "title": ""}).status_code == 400
            assert c.post("/api/admin/broadcast", headers=AH, json={"mode": "custom", "title": "x", "link": "javascript:1"}).status_code == 400
            c.post("/api/admin/broadcast", headers=AH, json={"mode": "custom", "title": "축제 안내", "body": "토요일", "link": "#/news"})
            r = c.post("/api/admin/broadcast", headers=AH, json={"mode": "favorites", "hours": 6}).json()
            assert r["sent"] >= 2
            # 로그인 안 한 앱도 공지는 받음
            f2 = c.get(f"/api/app/feed?after_bc={f0['latest_bc']}&promo=1").json()
            titles = [b["title"] for b in f2["broadcasts"]]
            assert "축제 안내" in titles and any("나중 행사" in t for t in titles)
            assert f2["promo"] is None or "어떠세요" in f2["promo"]["title"]
            with SessionLocal() as db:
                assert db.query(Notification).filter_by(user_id=uid, kind="notice").count() >= 2
        finally:
            with SessionLocal() as db:
                for i in ids:
                    db.delete(db.get(Event, i))
                db.query(Broadcast).delete()
                db.commit()


def test_apk_upload_and_info():
    """관리자 APK 올리기 → 웹 설치 안내용 정보·내려받기."""
    from fastapi.testclient import TestClient
    from app.auth import hash_password, make_token
    from app.db import SessionLocal
    from app.main import app
    from app.models import User
    with TestClient(app) as c:
        with SessionLocal() as db:
            admin = db.query(User).filter_by(username="bcadmin").one_or_none() or User(username="bcadmin", nickname="관리", password_hash=hash_password("x-pass-123"), is_admin=True)
            db.add(admin); db.commit()
            AH = {"Authorization": f"Bearer {make_token(admin)}"}
        assert c.get("/api/app/apk").json()["available"] is False
        assert c.post("/api/admin/app/apk", headers=AH, files={"file": ("x.txt", b"hello")}).status_code == 400
        assert c.post("/api/admin/app/apk", headers=AH, files={"file": ("wolgyeon.apk", b"PK\x03\x04" + b"0" * 2000)}).json()["ok"]
        info = c.get("/api/app/apk").json()
        assert info["available"] and info["url"] == "/download/wolgyeon.apk"
        r = c.get("/download/wolgyeon.apk")
        assert r.status_code == 200 and r.headers["content-type"] == "application/vnd.android.package-archive"
        c.delete("/api/admin/app/apk", headers=AH)
        assert c.get("/api/app/apk").json()["available"] is False
