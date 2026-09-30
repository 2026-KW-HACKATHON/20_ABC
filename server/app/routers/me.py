"""로그인 사용자 전용: 할 일 메모, 알림."""
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from ..auth import require_user
from ..db import get_db
from ..models import Notification, Todo, User
from ..services import ai, todo_cats
from .events import iso

router = APIRouter(prefix="/api", tags=["me"])
log = logging.getLogger("wolgyeon.me")


# ------------------------------------------------------------------ 할 일 메모
class TodoIn(BaseModel):
    text: str = Field(min_length=1, max_length=100)


class TodoPatch(BaseModel):
    text: str | None = Field(default=None, min_length=1, max_length=100)
    done: bool | None = None


def todo_out(t: Todo) -> dict:
    return {"id": t.id, "text": t.text, "done": t.done, "cats": todo_cats.match(t.text)}


@router.get("/todos")
def list_todos(user: User = Depends(require_user), db: Session = Depends(get_db)):
    return [todo_out(t) for t in db.scalars(select(Todo).where(Todo.user_id == user.id).order_by(Todo.done, Todo.id))]


@router.post("/todos")
def add_todo(body: TodoIn, user: User = Depends(require_user), db: Session = Depends(get_db)):
    if db.scalar(select(func.count()).select_from(Todo).where(Todo.user_id == user.id)) >= 50:
        raise HTTPException(400, "메모는 50개까지 저장할 수 있습니다.")
    t = Todo(user_id=user.id, text=body.text.strip())
    db.add(t)
    db.commit()
    return todo_out(t)


@router.patch("/todos/{todo_id}")
def patch_todo(todo_id: int, body: TodoPatch, user: User = Depends(require_user), db: Session = Depends(get_db)):
    t = db.get(Todo, todo_id)
    if not t or t.user_id != user.id:
        raise HTTPException(404, "메모를 찾을 수 없습니다.")
    if body.text is not None:
        t.text = body.text.strip()
    if body.done is not None:
        t.done = body.done
    db.commit()
    return todo_out(t)


@router.delete("/todos/{todo_id}")
def delete_todo(todo_id: int, user: User = Depends(require_user), db: Session = Depends(get_db)):
    t = db.get(Todo, todo_id)
    if not t or t.user_id != user.id:
        raise HTTPException(404, "메모를 찾을 수 없습니다.")
    db.delete(t)
    db.commit()
    return {"ok": True}


class CatIn(BaseModel):
    items: list[str] = Field(max_length=20)


@router.post("/todos/categorize")
def categorize(body: CatIn, user: User = Depends(require_user)):
    """메모 → 들를 가게 종류. 키워드 사전으로 못 찾은 항목만 AI에 물어봄."""
    res = {t: todo_cats.match(t) for t in body.items}
    unknown = [t for t, c in res.items() if not c]
    if unknown and ai.enabled():
        try:
            res.update({k: v for k, v in ai.categorize_todos(unknown, list(todo_cats.POI_LABELS)).items() if k in res})
        except Exception as e:
            log.warning("메모 AI 분류 실패: %s", e)
    return {"items": [{"text": t, "cats": res.get(t, [])} for t in body.items], "labels": todo_cats.POI_LABELS}


# ------------------------------------------------------------------ 알림
@router.get("/notifications")
def notifications(user: User = Depends(require_user), db: Session = Depends(get_db)):
    rows = db.scalars(select(Notification).where(Notification.user_id == user.id)
                      .order_by(Notification.created_at.desc()).limit(100))
    unread = db.scalar(select(func.count()).select_from(Notification)
                       .where(Notification.user_id == user.id, Notification.read.is_(False)))
    return {"unread": unread, "items": [{"id": n.id, "kind": n.kind, "title": n.title, "body": n.body, "link": n.link,
                                         "read": n.read, "created_at": iso(n.created_at)} for n in rows]}


@router.get("/notifications/unread")
def unread_count(user: User = Depends(require_user), db: Session = Depends(get_db)):
    return {"unread": db.scalar(select(func.count()).select_from(Notification)
                                .where(Notification.user_id == user.id, Notification.read.is_(False)))}


@router.post("/notifications/read-all")
def read_all(user: User = Depends(require_user), db: Session = Depends(get_db)):
    db.execute(update(Notification).where(Notification.user_id == user.id).values(read=True))
    db.commit()
    return {"ok": True}


@router.post("/notifications/{nid}/read")
def read_one(nid: int, user: User = Depends(require_user), db: Session = Depends(get_db)):
    n = db.get(Notification, nid)
    if n and n.user_id == user.id:
        n.read = True
        db.commit()
    return {"ok": True}
