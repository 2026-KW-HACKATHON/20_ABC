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
