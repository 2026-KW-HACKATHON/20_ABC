"""AI 연결 — 사진 신문고 분류, 공지 → 행사 정보 추출, 메모 분류(보조).

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
from ..models import EVENT_CATEGORIES, REPORT_CATEGORIES

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


# ------------------------------------------------------------------ 신문고 사진 분류
_REPORT_TOOL = {
    "name": "report_classification",
    "description": "주민이 찍은 동네 불편 사진의 분류 결과를 기록한다.",
    "input_schema": {
        "type": "object",
        "properties": {
            "category": {"type": "string", "enum": list(REPORT_CATEGORIES.keys()) + ["not_issue"],
                         "description": "; ".join(f"{k}={v}" for k, v in REPORT_CATEGORIES.items()) +
                                        "; not_issue=동네 불편과 관계없는 사진"},
            "confidence": {"type": "number", "description": "0~1 사이 확신도"},
            "summary": {"type": "string", "description": "사진 속 문제를 한국어 한 문장으로 (40자 이내)"},
            "severity": {"type": "integer", "enum": [1, 2, 3], "description": "1=경미, 2=보통, 3=즉시 조치 필요"},
            "privacy": {"type": "boolean", "description": "사람 얼굴이나 차량 번호판이 또렷하게 보이면 true"},
        },
        "required": ["category", "confidence", "summary", "severity", "privacy"],
    },
}
_REPORT_SYSTEM = (
    "당신은 서울 노원구 월계1동 생활 불편 신고를 분류하는 담당자입니다. "
    "사진을 보고 가장 알맞은 유형 하나를 고르세요. 보도블록 파손·포트홀은 road_damage, "
    "보도 위 적치물·단차·볼라드는 obstacle, 계단만 있고 경사로가 없거나 휠체어·유아차가 못 지나가는 곳은 accessibility, "
    "가로등·벤치·표지판·신호등 고장은 facility 입니다. 확신이 낮으면 confidence를 낮게 주세요."
)


def classify_report(image_jpeg: bytes, user_note: str = "") -> dict:
    b64 = base64.standard_b64encode(image_jpeg).decode()
    content = [
        {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": b64}},
        {"type": "text", "text": "이 사진의 문제 유형을 분류해주세요." + (f"\n신고자 메모: {user_note[:200]}" if user_note else "")},
    ]
    out = _tool_call(_REPORT_SYSTEM, content, _REPORT_TOOL, 400)
    cat = out.get("category")
    if cat not in REPORT_CATEGORIES and cat != "not_issue":
        cat = "other"
    return {
        "category": cat,
        "confidence": max(0.0, min(1.0, float(out.get("confidence", 0)))),
        "summary": str(out.get("summary", ""))[:120],
        "severity": int(out.get("severity", 1)) if str(out.get("severity", "1")).isdigit() else 1,
        "privacy": bool(out.get("privacy", False)),
    }


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


# ------------------------------------------------------------------ 메모 → 가게 종류 (키워드로 못 찾은 것만)
_TODO_TOOL = {
    "name": "todo_places",
    "description": "할 일 메모마다 들러야 할 가게 종류를 고른다.",
    "input_schema": {
        "type": "object",
        "properties": {
            "items": {"type": "array", "items": {
                "type": "object",
                "properties": {"text": {"type": "string"},
                               "cats": {"type": "array", "items": {"type": "string"}}},
                "required": ["text", "cats"]}}
        },
        "required": ["items"],
    },
}


def categorize_todos(texts: list[str], allowed: list[str]) -> dict[str, list[str]]:
    content = [{"type": "text", "text": "가능한 가게 종류: " + ", ".join(allowed) +
                "\n각 메모에 맞는 종류를 1~3개 고르세요 (가게가 필요 없으면 빈 배열):\n" +
                json.dumps(texts, ensure_ascii=False)}]
    out = _tool_call("장보기·볼일 메모를 가게 종류로 바꾸는 도우미입니다.", content, _TODO_TOOL, 500)
    res = {}
    for it in out.get("items", []):
        res[it.get("text", "")] = [c for c in it.get("cats", []) if c in allowed]
    return res
