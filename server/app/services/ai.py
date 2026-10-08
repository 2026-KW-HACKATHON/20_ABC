"""AI 연결 — 행사 포스터 사진 → 행사 정보, 공지·구청 문서 → 행사 정보 추출, 메모 분류(보조).

Gemini API(무료 등급 있음) 또는 Claude API 중 하나를 씁니다.
  AI_PROVIDER=gemini | anthropic  (비우면 키가 있는 쪽을 자동 선택, 둘 다 있으면 gemini)
"""
from __future__ import annotations

import base64
import json
import logging
import time

import httpx

from ..config import AI_PROVIDER, ANTHROPIC_API_KEY, ANTHROPIC_MODEL, GEMINI_API_KEY, GEMINI_MODEL
from ..models import EVENT_CATEGORIES

log = logging.getLogger("wolgyeon.ai")
_client = None          # Claude SDK 클라이언트
_gemini_http = None     # Gemini REST 호출용 httpx 클라이언트 (테스트에서 바꿔 끼울 수 있음)


def provider() -> str:
    if AI_PROVIDER in ("gemini", "anthropic"):
        return AI_PROVIDER if (GEMINI_API_KEY if AI_PROVIDER == "gemini" else ANTHROPIC_API_KEY) else ""
    if GEMINI_API_KEY:
        return "gemini"
    if ANTHROPIC_API_KEY:
        return "anthropic"
    return ""


def enabled() -> bool:
    return bool(provider())


def label() -> str:
    return {"gemini": f"Google Gemini ({GEMINI_MODEL})", "anthropic": f"Anthropic Claude ({ANTHROPIC_MODEL})"}.get(provider(), "")


class QuotaError(RuntimeError):
    """무료 사용 한도 초과."""


def _get_client():
    global _client
    if _client is None:
        import anthropic
        _client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY, timeout=40, max_retries=2)
    return _client


def _tool_call(system: str, content: list, tool: dict, max_tokens: int = 800) -> dict:
    """정해진 형식(JSON)으로 답을 받는다. content 는 Claude 형식 블록 목록(text / image)."""
    if provider() == "gemini":
        return _gemini_call(system, content, tool["input_schema"], max_tokens)
    msg = _get_client().messages.create(
        model=ANTHROPIC_MODEL,
        max_tokens=max_tokens,
        system=system,
        tools=[tool],
        tool_choice={"type": "tool", "name": tool["name"]},
        messages=[{"role": "user", "content": content}],
    )
    for block in msg.content:
        if getattr(block, "type", "") == "tool_use":
            return dict(block.input)
    raise RuntimeError("AI 응답에 결과가 없습니다.")


# ------------------------------------------------------------------ Gemini
def _gemini_schema(s: dict) -> dict:
    """JSON Schema → Gemini responseSchema (OpenAPI 부분집합: 대문자 타입, 문자열 enum만)."""
    t = s.get("type", "string")
    out: dict = {"type": t.upper()}
    if s.get("description"):
        out["description"] = s["description"]
    if t == "string" and s.get("enum"):
        out["enum"] = [str(x) for x in s["enum"]]
    if t == "object":
        out["properties"] = {k: _gemini_schema(v) for k, v in s.get("properties", {}).items()}
        if s.get("required"):
            out["required"] = list(s["required"])
    if t == "array":
        out["items"] = _gemini_schema(s.get("items", {"type": "string"}))
    return out


def tool_call_long(system: str, content: list, tool: dict, max_tokens: int = 16000) -> dict:
    """긴 문서(PDF)용: 출력이 길고 시간이 오래 걸리는 호출."""
    if provider() == "gemini":
        return _gemini_call(system, content, tool["input_schema"], max_tokens, timeout=240)
    msg = _get_client().with_options(timeout=240).messages.create(
        model=ANTHROPIC_MODEL, max_tokens=max_tokens, system=system, tools=[tool],
        tool_choice={"type": "tool", "name": tool["name"]}, messages=[{"role": "user", "content": content}])
    for block in msg.content:
        if getattr(block, "type", "") == "tool_use":
            return dict(block.input)
    raise RuntimeError("AI 응답에 결과가 없습니다.")


def _gemini_call(system: str, content: list, schema: dict, max_tokens: int, timeout: float = 45) -> dict:
    global _gemini_http
    if _gemini_http is None:
        _gemini_http = httpx.Client(timeout=45)
    parts = []
    for block in content:
        if block["type"] in ("image", "document"):
            parts.append({"inlineData": {"mimeType": block["source"]["media_type"], "data": block["source"]["data"]}})
        else:
            parts.append({"text": block["text"]})
    body = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {"responseMimeType": "application/json", "responseSchema": _gemini_schema(schema),
                             "maxOutputTokens": max(1024, max_tokens * 2), "temperature": 0.2},
    }
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
    for attempt in range(3):
        r = _gemini_http.post(url, json=body, headers={"x-goog-api-key": GEMINI_API_KEY}, timeout=timeout)
        if r.status_code in (429, 500, 503) and attempt < 2:
            time.sleep(1.5 * (attempt + 1))
            continue
        break
    if r.status_code == 429:
        raise QuotaError("Gemini 무료 사용 한도를 넘었습니다. 잠시 후 다시 시도해주세요.")
    if r.status_code >= 400:
        raise RuntimeError(f"Gemini 오류 {r.status_code}: {r.text[:300]}")
    data = r.json()
    try:
        cand = data["candidates"][0]
        text = "".join(p.get("text", "") for p in cand["content"]["parts"] if not p.get("thought"))
        return json.loads(text)
    except (KeyError, IndexError, json.JSONDecodeError) as e:
        reason = (data.get("candidates") or [{}])[0].get("finishReason") or data.get("promptFeedback", {}).get("blockReason")
        raise RuntimeError(f"Gemini 응답을 해석하지 못했습니다 ({reason or e}).")


# ------------------------------------------------------------------ 행사 포스터 사진 → 행사 정보 (주민 행사 제보)
_POSTER_TOOL = {
    "name": "poster_event",
    "description": "행사 포스터·전단·안내문 사진에서 행사 정보를 읽어 기록한다.",
    "input_schema": {
        "type": "object",
        "properties": {
            "is_event": {"type": "boolean", "description": "사진이 행사(공연·전시·장터·강연·축제·모임 등) 안내물이면 true"},
            "title": {"type": "string", "description": "행사 이름. 모르면 빈 문자열"},
            "category": {"type": "string", "enum": list(EVENT_CATEGORIES.keys()),
                         "description": "; ".join(f"{k}={v}" for k, v in EVENT_CATEGORIES.items())},
            "start": {"type": "string", "description": "시작 YYYY-MM-DD 또는 YYYY-MM-DD HH:MM. 모르면 빈 문자열"},
            "end": {"type": "string", "description": "끝 YYYY-MM-DD 또는 YYYY-MM-DD HH:MM. 모르면 빈 문자열"},
            "time_text": {"type": "string", "description": "포스터에 적힌 일시 그대로 짧게"},
            "place": {"type": "string", "description": "장소 이름 (주소가 있으면 함께)"},
            "host": {"type": "string", "description": "주최·주관"},
            "fee": {"type": "string", "description": "참가비·입장료 (무료면 '무료', 모르면 빈 문자열)"},
            "summary": {"type": "string", "description": "주민이 보기 쉬운 1~2문장 소개"},
        },
        "required": ["is_event", "title", "category", "start", "end", "time_text", "place", "host", "fee", "summary"],
    },
}


def extract_poster(image_jpeg: bytes, today: str) -> dict:
    """행사 포스터 사진을 읽어 제보 양식을 미리 채울 값을 돌려준다. 연도가 없으면 today 기준으로 가까운 미래."""
    b64 = base64.standard_b64encode(image_jpeg).decode()
    content = [
        {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": b64}},
        {"type": "text", "text": f"오늘은 {today}입니다. 이 사진의 행사 정보를 읽어주세요. 적혀 있지 않은 정보는 지어내지 말고 빈 문자열로 두세요."},
    ]
    out = _tool_call("동네 행사 포스터를 읽고 행사 정보를 정리하는 도우미입니다.", content, _POSTER_TOOL, 700)
    if out.get("category") not in EVENT_CATEGORIES:
        out["category"] = "community"
    return {k: (out.get(k) if k == "is_event" else str(out.get(k) or ""))
            for k in ("is_event", "title", "category", "start", "end", "time_text", "place", "host", "fee", "summary")}


# ------------------------------------------------------------------ 공지사항 → 행사 정보
_EVENT_TOOL = {
    "name": "event_info",
    "description": "공지사항 본문에서 주민이 참여할 수 있는 행사 정보를 뽑는다.",
    "input_schema": {
        "type": "object",
        "properties": {
            "is_public_event": {"type": "boolean",
                                "description": "지역 주민이나 일반인이 참여·관람할 수 있는 행사(공연, 전시, 강연, 축제, 경기, 체험 등)면 true. 학사·장학·채용·내부 모집 공지는 false"},
            "title": {"type": "string", "description": "행사 이름 (말머리·괄호 안 부서명 제외)"},
            "category": {"type": "string", "enum": list(EVENT_CATEGORIES.keys()),
                         "description": "; ".join(f"{k}={v}" for k, v in EVENT_CATEGORIES.items())},
            "start": {"type": "string", "description": "시작 일시 YYYY-MM-DD 또는 YYYY-MM-DD HH:MM. 모르면 빈 문자열"},
            "end": {"type": "string", "description": "종료 일시. 모르면 빈 문자열"},
            "time_text": {"type": "string", "description": "사람이 읽는 일시 설명 (예: 10월 2일(금) 14:00~16:00)"},
            "place": {"type": "string", "description": "장소 (건물·호실 포함). 모르면 빈 문자열"},
            "summary": {"type": "string", "description": "주민이 보기 쉬운 2~3문장 소개"},
            "target": {"type": "string", "description": "참여 대상 (예: 누구나, 재학생)"},
        },
        "required": ["is_public_event", "title", "category", "start", "end", "time_text", "place", "summary", "target"],
    },
}


def extract_event(title: str, body: str, posted: str) -> dict:
    content = [{"type": "text", "text": f"게시일: {posted}\n제목: {title}\n\n본문:\n{body[:6000]}"}]
    return _tool_call("광운대학교 공지사항을 읽고 행사 정보를 정리하는 도우미입니다. 연도가 없으면 게시일 기준으로 판단하세요.",
                      content, _EVENT_TOOL, 700)


# ------------------------------------------------------------------ 행사 정보 빈칸 채우기
_FILL_TOOL = {
    "name": "event_fill",
    "description": "행사의 비어 있는 정보를 원문에서 찾아 채운다.",
    "input_schema": {
        "type": "object",
        "properties": {
            "description": {"type": "string", "description": "주민이 보기 쉬운 2~3문장 소개. 원문·알려진 정보에 있는 내용만"},
            "start": {"type": "string", "description": "시작 YYYY-MM-DD 또는 YYYY-MM-DD HH:MM. 원문에 없으면 빈 문자열"},
            "end": {"type": "string", "description": "끝 YYYY-MM-DD 또는 YYYY-MM-DD HH:MM. 원문에 없으면 빈 문자열"},
            "time_text": {"type": "string", "description": "사람이 읽는 일시 설명 (예: 매주 토 14:00~16:00). 없으면 빈 문자열"},
            "place": {"type": "string", "description": "장소 이름. 없으면 빈 문자열"},
            "host": {"type": "string", "description": "주최·주관. 없으면 빈 문자열"},
            "fee": {"type": "string", "description": "참가비·관람료 (무료면 '무료'). 없으면 빈 문자열"},
            "target": {"type": "string", "description": "참여 대상. 없으면 빈 문자열"},
        },
        "required": ["description", "start", "end", "time_text", "place", "host", "fee", "target"],
    },
}


def fill_event(known: dict, source_text: str, today: str) -> dict:
    """비어 있는 칸을 원문(source_text)에서 찾아 채운다. 원문이 없으면 소개만 알려진 정보로 짧게 정리."""
    content = [{"type": "text", "text":
                f"오늘: {today}\n알려진 정보(JSON): {json.dumps(known, ensure_ascii=False)}\n\n"
                f"원문:\n{(source_text or '(원문 없음)')[:7000]}"}]
    system = ("지역 행사 정보를 정리하는 도우미입니다. 알려진 정보에서 비어 있는 항목만 채우세요. "
              "원문이나 알려진 정보에 근거가 없는 날짜·장소·요금·주최는 절대 지어내지 말고 빈 문자열로 두세요. "
              "소개는 알려진 사실만으로 2~3문장, 과장 없이 쓰세요.")
    out = _tool_call(system, content, _FILL_TOOL, 700)
    return {k: str(out.get(k) or "").strip() for k in _FILL_TOOL["input_schema"]["properties"]}
