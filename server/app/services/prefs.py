"""사용자 알림 설정."""
from __future__ import annotations

import json

from sqlalchemy.orm import Session

from ..models import UserPref

DEFAULTS = {"fav_hours": 24, "promo": True}
FAV_HOURS = (0, 1, 2, 3, 6, 12, 24, 48)     # 0 = 즐겨찾기 알림 끄기


def get(db: Session, user_id: int) -> dict:
    row = db.get(UserPref, user_id)
    out = dict(DEFAULTS)
    if row:
        try:
            out.update({k: v for k, v in json.loads(row.data or "{}").items() if k in DEFAULTS})
        except ValueError:
            pass
    return out


def put(db: Session, user_id: int, data: dict) -> dict:
    cur = get(db, user_id)
    if "fav_hours" in data and int(data["fav_hours"]) in FAV_HOURS:
        cur["fav_hours"] = int(data["fav_hours"])
    if "promo" in data:
        cur["promo"] = bool(data["promo"])
    row = db.get(UserPref, user_id) or UserPref(user_id=user_id)
    row.data = json.dumps(cur)
    db.add(row)
    db.commit()
    return cur


def all_fav_hours(db: Session) -> dict[int, int]:
    out = {}
    for row in db.query(UserPref):
        try:
            out[row.user_id] = int(json.loads(row.data or "{}").get("fav_hours", DEFAULTS["fav_hours"]))
        except (ValueError, TypeError):
            pass
    return out
