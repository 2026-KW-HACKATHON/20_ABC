"""할 일 메모 → 들를 가게 종류 (키워드 사전 우선, 모르면 AI 보조)."""
POI_LABELS = {
    "convenience": "편의점", "supermarket": "마트", "variety": "생활용품점(다이소 등)",
    "cosmetics": "화장품·드럭스토어", "greengrocer": "과일·채소가게", "bakery": "빵집", "butcher": "정육점",
    "stationery": "문구점", "hardware": "철물점", "clothes": "옷가게", "laundry": "세탁소",
    "electronics": "전자제품·휴대폰", "books": "서점", "florist": "꽃집", "pharmacy": "약국", "cafe": "카페",
    "bank": "은행·ATM", "post_office": "우체국", "clinic": "병원·의원", "restaurant": "식당",
    "library": "도서관", "public": "주민센터·공공기관",
}

KEYWORDS = [
    (("휴지", "화장지", "물티슈", "키친타월", "세제", "샴푸", "린스", "치약", "칫솔", "생필품", "건전지", "쓰레기봉투", "종량제"),
     ["convenience", "supermarket", "variety"]),
    (("과일", "사과", "바나나", "귤", "포도", "딸기", "수박", "채소", "야채", "양파", "대파", "감자"), ["greengrocer", "supermarket"]),
    (("화장품", "스킨", "로션", "선크림", "립", "마스크팩", "클렌징", "렌즈"), ["cosmetics", "supermarket"]),
    (("약국", "감기약", "두통약", "상비약", "진통제", "소화제", "밴드", "파스", "연고", "영양제"), ["pharmacy"]),
    (("빵", "케이크", "식빵"), ["bakery", "convenience"]),
    (("커피", "라떼", "음료"), ["cafe", "convenience"]),
    (("우유", "라면", "과자", "간식", "생수", "계란", "달걀", "두부", "햇반", "도시락", "맥주", "술"), ["convenience", "supermarket"]),
    (("고기", "삼겹살", "돼지", "소고기", "닭"), ["butcher", "supermarket"]),
    (("문구", "펜", "볼펜", "노트", "공책", "포스트잇", "테이프", "가위", "풀"), ["stationery", "variety", "convenience"]),
    (("택배", "우편", "등기", "편지"), ["post_office", "convenience"]),
    (("현금", "atm", "ATM", "입금", "출금", "통장"), ["bank", "convenience"]),
    (("전구", "못", "나사", "공구", "드라이버", "실리콘"), ["hardware", "variety"]),
    (("세탁", "드라이", "수선"), ["laundry"]),
    (("충전기", "케이블", "이어폰", "폰", "휴대폰"), ["electronics", "variety"]),
    (("책", "문제집"), ["books"]),
    (("꽃", "화분"), ["florist"]),
    (("병원", "진료", "치과", "한의원"), ["clinic"]),
    (("등본", "서류", "민원", "주민센터"), ["public"]),
    (("반납", "대출", "도서관"), ["library"]),
    (("다이소", "수납", "청소"), ["variety"]),
]


def match(text: str) -> list[str]:
    t = text.strip()
    for words, cats in KEYWORDS:
        if any(w in t for w in words):
            return cats
    return []
