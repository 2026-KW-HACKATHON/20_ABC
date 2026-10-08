"""행사 검색 — 이름·소개에 그 낱말이 없어도 '연관된' 행사까지 찾아 줌.

점수 = 직접 일치(이름 > 소개·AI 키워드 > 장소·주최) + 연관어 일치 + 세부 종류 일치
 1) 연관어 사전(CONCEPTS): '아이'를 찾으면 어린이·유아·가족·그림책… 도 함께 찾음
 2) 세부 종류(kinds): '음악'을 찾으면 종류가 '음악'인 행사 (콘서트·국악·버스킹…)
 3) AI 키워드(EventTag): 행사마다 AI가 붙여 둔 연관 키워드 (예: 북토크 → 작가, 인문학, 어른, 조용한)
월계동 밖 행사도 결과에 나오며 in_area=False 로 표시됨 (지도·달력에는 월계동 안 행사만 나옴).
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import time

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import EVENT_CATEGORIES, Event, EventTag, now
from . import ai, geo
from .kinds import KINDS, event_kind

log = logging.getLogger("wolgyeon.search")

CONCEPTS: list[tuple[str, ...]] = [
    ("아이", "어린이", "아동", "유아", "키즈", "가족", "초등", "동화", "그림책", "인형극", "부모", "놀이", "자녀"),
    ("어르신", "노인", "시니어", "실버", "경로", "노년", "효"),
    ("청소년", "청년", "학생", "중학생", "고등학생", "대학생", "10대", "20대", "진로"),
    ("책", "도서관", "독서", "북토크", "작가", "인문학", "그림책", "낭독", "글쓰기", "문학", "시인"),
    ("운동", "체육", "스포츠", "걷기", "마라톤", "달리기", "요가", "배드민턴", "탁구", "축구", "테니스", "게이트볼",
     "파크골프", "수영", "자전거", "족구", "야구", "생활체육"),
    ("건강", "검진", "보건", "치매", "금연", "마음", "심리", "상담", "힐링", "명상", "웰빙"),
    ("먹거리", "음식", "푸드", "요리", "시식", "김장", "송편", "베이킹", "쿠킹", "맛집", "간식"),
    ("장터", "시장", "마켓", "바자회", "플리마켓", "벼룩", "중고", "직거래", "알뜰", "야시장", "판매"),
    ("환경", "기후", "탄소", "재활용", "업사이클", "에코", "생태", "텃밭", "농사", "벼농사", "제로웨이스트"),
    ("자연", "공원", "생태", "나들이", "산책", "캠핑", "숲길", "유아숲", "하천", "천변"),
    ("꽃", "정원", "식물", "가드닝", "원예", "국화", "화분"),
    ("과학", "코딩", "인공지능", "로봇", "메이커", "수학", "천문", "우주", "과학관", "실험", "드론", "소프트웨어"),
    ("미술", "전시", "그림", "갤러리", "사진", "작품", "공예", "서예", "드로잉", "아트", "미술관"),
    ("역사", "전통", "문화유산", "한글", "국악", "민속", "박물관", "생활사", "유적"),
    ("축제", "페스티벌", "한마당", "잔치", "문화제", "불꽃", "퍼레이드"),
    ("봉사", "자원봉사", "나눔", "기부", "후원", "돌봄"),
    ("일자리", "취업", "채용", "창업", "면접", "자격증", "직업", "구직"),
    ("반려동물", "강아지", "반려견", "고양이", "반려묘", "펫"),
    ("영화", "시네마", "상영", "극장", "무비", "다큐"),
    ("공부", "강연", "강의", "특강", "강좌", "교육", "세미나", "포럼", "아카데미", "학습", "클래스", "수업"),
    ("체험", "만들기", "공방", "원데이", "실습", "diy", "키트"),
    ("밤", "야간", "저녁", "야시장", "별빛", "달빛", "조명"),
    ("가을", "추석", "한가위", "단풍", "할로윈", "핼러윈"),
    ("겨울", "크리스마스", "연말", "송년", "눈썰매"),
    ("외국인", "다문화", "글로벌", "세계", "영어", "외국어"),
    ("장애인", "장애", "배리어프리", "휠체어", "보장구", "무장애"),
    ("음악", "노래", "가요", "트로트", "합창", "밴드", "콘서트", "음악회", "버스킹", "오케스트라", "연주", "클래식", "재즈"),
    ("공연", "연극", "뮤지컬", "무용", "댄스", "마술", "인형극", "낭독극", "콘서트"),
    ("대회", "경연", "경진", "공모", "챌린지", "콘테스트", "해커톤", "백일장"),
    ("주민", "마을", "동네", "공동체", "이웃", "주민자치"),
    ("광운대", "광운대학교", "대학", "캠퍼스"),
    ("무료", "공짜", "무료입장"),
]


def norm(s: str) -> str:
    return re.sub(r"\s+", "", (s or "")).lower()


def _triggers(tok: str, term: str) -> bool:
    t, w = norm(tok), norm(term)
    if not t or not w:
        return False
    if t == w:
        return True
    if len(w) >= 2 and w in t:                 # '음악회'를 찾으면 '음악' 묶음
        return True
    return len(t) >= 2 and w.startswith(t)      # '도서' → '도서관'


def expand(tok: str) -> tuple[list[str], list[str]]:
    """검색어 하나 → (연관어 목록, 관련 세부 종류 목록)."""
    rel: list[str] = []
    for g in CONCEPTS:
        if any(_triggers(tok, w) for w in g):
            rel += [w for w in g if len(w) >= 2]
    kinds = []
    for k, v in KINDS.items():
        if _triggers(tok, v["label"].split("·")[0]) or any(_triggers(tok, w) for w in v["words"] if len(w) >= 2):
            kinds.append(k)
            rel += [w for w in v["words"] if len(w) >= 2]
    t = norm(tok)
    seen, out = {t}, []
    for w in rel:
        n = norm(w)
        if n not in seen:
            seen.add(n)
            out.append(w)
    return out, kinds


def tokens(q: str) -> list[str]:
    q = re.sub(r"[^\w\s가-힣]", " ", q or "").strip()
    toks = [t for t in q.split() if t]
    return toks[:6]


def score_event(e: Event, tags: str, toks: list[str], expansions: dict) -> tuple[float, list[str]]:
    title, desc, place = norm(e.title), norm(e.description), norm(e.place_name)
    host, fee, tg = norm(e.host), norm(e.fee), norm(tags)
    kind = event_kind(e.title, e.description, e.category)
    total, reasons = 0.0, []
    for tok in toks:
        t = norm(tok)
        s = 0.0
        why = None
        if t in title:
            s, why = 10, f"이름에 '{tok}'"
        elif t in desc:
            s, why = 6, f"소개에 '{tok}'"
        elif t in tg:
            s, why = 5, f"연관 키워드 '{tok}'"
        elif t in place:
            s, why = 5, f"장소에 '{tok}'"
        elif t in host or t in fee:
            s, why = 3, f"주최·요금에 '{tok}'"
        rel, kinds = expansions[tok]
        if kind in kinds:
            s += 4 if s else 7
            why = why or f"'{KINDS[kind]['label']}' 종류"
        if not why or s < 7:
            for w in rel:
                n = norm(w)
                if n in title:
                    s += 5
                    why = why or f"'{w}' ('{tok}' 관련)"
                    break
                if n in tg or n in desc:
                    s += 3
                    why = why or f"'{w}' ('{tok}' 관련)"
                    break
        if t in EVENT_CATEGORIES.get(e.category, ""):
            s += 2
            why = why or f"'{EVENT_CATEGORIES[e.category]}' 분류"
        if s:
            total += s
            if why and why not in reasons:
                reasons.append(why)
    return total, reasons[:3]


def search(db: Session, q: str, include_past: bool = False, category: str | None = None,
           limit: int = 80) -> list[tuple[Event, float, list[str]]]:
    toks = tokens(q)
    if not toks:
        return []
    exps = {t: expand(t) for t in toks}
    stmt = select(Event).where(Event.status == "approved")
    if category in EVENT_CATEGORIES:
        stmt = stmt.where(Event.category == category)
    rows = list(db.scalars(stmt))
    tags = dict(db.execute(select(EventTag.event_id, EventTag.tags).where(EventTag.event_id.in_([e.id for e in rows]))).all()) if rows else {}
    today = now().replace(hour=0, minute=0, second=0, microsecond=0)
    out = []
    for e in rows:
        last = e.end_at or e.start_at
        past = bool(last and last < today)
        if past and not include_past:
            continue
        s, why = score_event(e, tags.get(e.id, ""), toks, exps)
        if s <= 0:
            continue
        if len(toks) > 1:     # 여러 낱말이면 모두 걸린 행사를 위로
            hit = sum(1 for t in toks if score_event(e, tags.get(e.id, ""), [t], exps)[0] > 0)
            s *= hit / len(toks)
        if past:
            s *= 0.6
        if e.lat is not None and e.lng is not None and geo.area_contains(e.lat, e.lng):
            s += 1.5          # 같은 점수면 월계동 안 행사를 먼저
        out.append((e, s, why))
    far = today.replace(year=today.year + 5)
    out.sort(key=lambda r: (-r[1], (r[0].start_at or far)))
    return out[:limit]


# ------------------------------------------------------------------ AI 연관 키워드
def _sig(e: Event) -> str:
    return hashlib.sha1(f"{e.title}|{(e.description or '')[:600]}".encode()).hexdigest()[:16]


_TAG_TOOL = {
    "name": "event_tags",
    "description": "행사마다 주민이 검색창에 칠 만한 연관 키워드를 붙인다.",
    "input_schema": {
        "type": "object",
        "properties": {"items": {"type": "array", "items": {
            "type": "object",
            "properties": {"id": {"type": "integer"},
                           "tags": {"type": "array", "items": {"type": "string"}, "description": "6~10개, 각 1~2 낱말"}},
            "required": ["id", "tags"]}}},
        "required": ["items"],
    },
}
_TAG_SYSTEM = (
    "당신은 동네 행사 앱의 검색 담당자입니다. 각 행사에 주민이 검색할 만한 한국어 연관 키워드를 6~10개 붙이세요. "
    "행사 이름에 이미 있는 낱말보다는, 이름에는 없지만 관련된 말(대상: 아이·가족·어르신·청소년, 분위기: 야외·조용한·신나는, "
    "주제·분야, 계절, 할 수 있는 활동, 비슷한 행사 종류)을 우선하세요. 장소 이름·날짜는 넣지 마세요. 지어낸 사실은 넣지 마세요."
)


def tag_batch(db: Session, limit: int = 60, per_call: int = 15, pause: float = 4.0) -> dict:
    """키워드가 없거나 내용이 바뀐 행사에 AI 연관 키워드를 붙임 (한 번 호출에 여러 행사)."""
    if not ai.enabled():
        return {"ok": False, "error": "AI 키가 없습니다 (GEMINI_API_KEY)."}
    rows = list(db.scalars(select(Event).where(Event.status.in_(("approved", "pending"))).order_by(Event.status, Event.id.desc())))
    have = {t.event_id: t for t in db.scalars(select(EventTag))}
    todo = [e for e in rows if e.id not in have or have[e.id].sig != _sig(e)][:limit]
    done = 0
    for i in range(0, len(todo), per_call):
        chunk = todo[i:i + per_call]
        payload = [{"id": e.id, "title": e.title, "category": EVENT_CATEGORIES.get(e.category, ""),
                    "description": (e.description or "")[:400], "target_fee": e.fee or ""} for e in chunk]
        try:
            out = ai._tool_call(_TAG_SYSTEM, [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}], _TAG_TOOL, 2500)
        except ai.QuotaError:
            db.commit()
            return {"ok": True, "tagged": done, "left": len(todo) - done, "stopped": "AI 무료 사용 한도에 걸려 멈췄습니다."}
        except Exception as ex:
            log.warning("연관 키워드 만들기 실패: %s", ex)
            break
        byid = {e.id: e for e in chunk}
        for it in out.get("items", []):
            e = byid.get(it.get("id"))
            if not e:
                continue
            tags = [re.sub(r"[,\n]", " ", str(t)).strip()[:20] for t in it.get("tags", []) if str(t).strip()][:12]
            row = have.get(e.id) or EventTag(event_id=e.id)
            row.tags, row.sig, row.created_at = ", ".join(tags), _sig(e), now()
            db.add(row)
            have[e.id] = row
            done += 1
        db.commit()
        if pause and i + per_call < len(todo):
            time.sleep(pause)
    return {"ok": True, "tagged": done, "left": max(0, len(todo) - done)}
