from datetime import datetime, timedelta, timezone

from sqlalchemy import (Boolean, DateTime, Float, ForeignKey, Integer, LargeBinary, String, Text,
                        UniqueConstraint)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


KST = timezone(timedelta(hours=9))


def now() -> datetime:
    """모든 시각은 한국시간(KST) 기준 naive datetime으로 저장합니다."""
    return datetime.now(KST).replace(tzinfo=None)


# 행사 카테고리 (보고서의 3대 카테고리)
EVENT_CATEGORIES = {
    "culture": "문화·예술",
    "academic": "학술·교육",
    "community": "지역·참여",
}

# 신문고 유형
REPORT_CATEGORIES = {
    "road_damage": "도로·보도 파손",
    "obstacle": "보행 장애물·단차",
    "illegal_parking": "불법 주정차",
    "trash": "쓰레기·무단투기",
    "facility": "공공시설 고장",
    "construction": "공사·먼지",
    "safety": "사고·안전 위험",
    "accessibility": "휠체어·유아차 통행 불가",
    "other": "기타",
}
REPORT_STATUS = {
    "received": "접수",
    "checking": "확인 중",
    "resolved": "처리 완료",
    "rejected": "반려",
}

# 길 제보 유형
PATH_KINDS = {
    "add": "새 길 (지도에 없는 길)",
    "block": "막힌 길",
    "gate": "쪽문·출입구",
    "stairs": "계단 있음",
    "steep": "가파른 길",
}


class User(Base):
    __tablename__ = "users"
    __table_args__ = {"sqlite_autoincrement": True}   # 탈퇴한 id 재사용 방지
    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    nickname: Mapped[str] = mapped_column(String(40))
    password_hash: Mapped[str] = mapped_column(String(200))
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    notify_categories: Mapped[str] = mapped_column(String(100), default="culture,academic,community")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class Event(Base):
    __tablename__ = "events"
    __table_args__ = (UniqueConstraint("source", "source_id", name="uq_event_source"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(300))
    category: Mapped[str] = mapped_column(String(20), default="community")
    start_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    end_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    time_text: Mapped[str] = mapped_column(String(200), default="")
    place_name: Mapped[str] = mapped_column(String(200), default="")
    lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    lng: Mapped[float | None] = mapped_column(Float, nullable=True)
    description: Mapped[str] = mapped_column(Text, default="")
    host: Mapped[str] = mapped_column(String(200), default="")
    contact: Mapped[str] = mapped_column(String(200), default="")
    fee: Mapped[str] = mapped_column(String(200), default="")
    url: Mapped[str] = mapped_column(String(500), default="")
    image_url: Mapped[str] = mapped_column(String(500), default="")
    source: Mapped[str] = mapped_column(String(20), default="manual")   # manual / seoul / kw
    source_id: Mapped[str] = mapped_column(String(120), default="")
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)  # pending/approved/rejected
    ai_note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)

    reviews = relationship("Review", back_populates="event", cascade="all, delete-orphan")


class Favorite(Base):
    __tablename__ = "favorites"
    __table_args__ = (UniqueConstraint("user_id", "event_id", name="uq_fav"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class Review(Base):
    __tablename__ = "reviews"
    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    rating: Mapped[int] = mapped_column(Integer, default=5)
    body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)

    event = relationship("Event", back_populates="reviews")
    user = relationship("User")


class Report(Base):
    __tablename__ = "reports"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    category: Mapped[str] = mapped_column(String(30), index=True)
    description: Mapped[str] = mapped_column(Text, default="")
    ai_category: Mapped[str] = mapped_column(String(30), default="")
    ai_confidence: Mapped[float] = mapped_column(Float, default=0)
    ai_summary: Mapped[str] = mapped_column(Text, default="")
    ai_severity: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(20), default="received", index=True)
    admin_note: Mapped[str] = mapped_column(Text, default="")
    image: Mapped[bytes] = mapped_column(LargeBinary)
    thumb: Mapped[bytes] = mapped_column(LargeBinary)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)

    user = relationship("User")


class Notification(Base):
    __tablename__ = "notifications"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(30))
    ref: Mapped[str] = mapped_column(String(60), default="")      # 중복 방지 키
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(Text, default="")
    link: Mapped[str] = mapped_column(String(200), default="")
    read: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class PathEdit(Base):
    """주민 길 제보 / 관리자 길 편집. 승인되면 경로 계산에 반영."""
    __tablename__ = "path_edits"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    kind: Mapped[str] = mapped_column(String(20))          # add/block/gate/stairs/steep
    coords: Mapped[str] = mapped_column(Text)              # JSON [[lat,lng], ...]
    note: Mapped[str] = mapped_column(Text, default="")
    open_hours: Mapped[str] = mapped_column(String(40), default="")   # "06:00-23:00" (쪽문)
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)


class Construction(Base):
    __tablename__ = "constructions"
    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(200))
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    radius_m: Mapped[float] = mapped_column(Float, default=40)
    start_date: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    end_date: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    dust: Mapped[bool] = mapped_column(Boolean, default=True)
    note: Mapped[str] = mapped_column(Text, default="")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    report_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)


class Todo(Base):
    __tablename__ = "todos"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    text: Mapped[str] = mapped_column(String(100))
    done: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class CollectLog(Base):
    __tablename__ = "collect_logs"
    id: Mapped[int] = mapped_column(primary_key=True)
    source: Mapped[str] = mapped_column(String(20))
    started_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    found: Mapped[int] = mapped_column(Integer, default=0)
    added: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str] = mapped_column(Text, default="")
