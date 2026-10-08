"""행사 세부 종류 — 지도 아이콘과 '음악만 숨기기' 같은 필터에 씀.

큰 분류(category: 문화·예술 / 학술·교육 / 지역·참여)는 색, 세부 종류(kind)는 아이콘.
제목 → 설명 순서로 키워드를 찾고, 없으면 큰 분류의 기본 종류로 둔다.
"""
from __future__ import annotations

# 순서가 중요: 앞에 있는 규칙이 먼저 걸림 (예: '댄스스포츠대회'는 체육, '댄스경연'은 공연)
KINDS: dict[str, dict] = {
    "festival": {"label": "축제", "cat": "culture",
                 "words": ("축제", "페스티벌", "한마당", "마을잔치", "큰잔치", "잔치", "주민공감")},
    "market":   {"label": "장터·바자회", "cat": "community",
                 "words": ("장터", "바자회", "바자", "마켓", "직거래", "야시장", "벼룩", "알뜰")},
    "sports":   {"label": "체육·걷기", "cat": "community",
                 "words": ("체육", "걷기", "탁구", "농구", "피구", "족구", "보치아", "댄스스포츠", "피트니스", "마라톤",
                           "운동회", "파크골프", "축구", "배드민턴", "스포츠", "점프")},
    "film":     {"label": "영화", "cat": "culture", "words": ("영화", "시네마", "상영")},
    "music":    {"label": "음악", "cat": "culture",
                 "words": ("음악회", "콘서트", "오케스트라", "밴드", "국악", "재즈", "버스킹", "합창", "연주", "정가",
                           "풍류", "클래식", "음악", "노래")},
    "show":     {"label": "공연·무대", "cat": "culture",
                 "words": ("공연", "연극", "뮤지컬", "인형극", "낭독극", "낭독 극장", "댄스", "무용", "장기자랑", "마술")},
    "exhibit":  {"label": "전시·미술", "cat": "culture",
                 "words": ("전시", "미술", "갤러리", "사진", "서예", "시화", "작품전", "기획전", "정기전", "신우전",
                           "박물관", "큐레이션")},
    "contest":  {"label": "대회·공모", "cat": "academic",
                 "words": ("경진", "대회", "챌린지", "공모", "콘테스트", "해커톤")},
    "lecture":  {"label": "강연·포럼", "cat": "academic",
                 "words": ("강연", "특강", "포럼", "세미나", "작가", "만남", "설명회", "심포지엄", "콘퍼런스", "토크")},
    "book":     {"label": "독서·도서관", "cat": "academic", "words": ("도서관", "독서", "책", "북")},
    "class":    {"label": "교육·체험", "cat": "academic",
                 "words": ("교육", "교실", "아카데미", "강좌", "체험", "만들기", "수업", "연수", "학습", "캠프",
                           "프로그램", "학교")},
    "share":    {"label": "나눔·봉사", "cat": "community",
                 "words": ("나눔", "봉사", "송편", "김장", "식당", "차례", "기부")},
    "meet":     {"label": "주민 모임", "cat": "community",
                 "words": ("모임", "주민", "선언", "행진", "위원회", "간담회")},
}
DEFAULT_KIND = {"culture": "show", "academic": "class", "community": "meet"}


def event_kind(title: str, description: str = "", category: str = "community") -> str:
    for text in (title or "", (description or "")[:300]):
        for k, v in KINDS.items():
            if any(w in text for w in v["words"]):
                return k
    return DEFAULT_KIND.get(category, "meet")


def kinds_meta() -> dict:
    return {k: {"label": v["label"], "cat": v["cat"]} for k, v in KINDS.items()}
