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
    source: Mapped[str] = mapped_column(String(20), default="manual")   # manual / seoul / kw / nowon / tip(주민 제보)
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
    media = relationship("ReviewMedia", cascade="all, delete-orphan", order_by="ReviewMedia.id")


class ReviewMedia(Base):
    """후기에 붙인 사진·영상 (파일은 DATA_DIR/media/reviews/ 에 저장)."""
    __tablename__ = "review_media"
    id: Mapped[int] = mapped_column(primary_key=True)
    review_id: Mapped[int] = mapped_column(ForeignKey("reviews.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(10))          # image / video
    filename: Mapped[str] = mapped_column(String(120))
    mime: Mapped[str] = mapped_column(String(40))
    size: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


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
    report_id: Mapped[int | None] = mapped_column(Integer, nullable=True)   # (예전 신문고 연결용, 사용 안 함)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)


class EventTag(Base):
    """검색용 연관 키워드 (AI가 행사 이름·소개를 읽고 붙임). 새 표라서 기존 DB에도 자동으로 추가됨."""
    __tablename__ = "event_tags"
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), primary_key=True)
    tags: Mapped[str] = mapped_column(Text, default="")          # 쉼표로 구분
    sig: Mapped[str] = mapped_column(String(20), default="")      # 제목·소개가 바뀌면 다시 만들기 위한 지문
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class CalendarNote(Base):
    """달력 날짜별 개인 메모."""
    __tablename__ = "calendar_notes"
    __table_args__ = (UniqueConstraint("user_id", "day", name="uq_note_day"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    day: Mapped[str] = mapped_column(String(10), index=True)      # YYYY-MM-DD
    text: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)


class UserPref(Base):
    """사용자 설정 (JSON). 예: {"fav_hours": 24, "promo": true} — 새 표라서 기존 DB에도 자동으로 추가됨."""
    __tablename__ = "user_prefs"
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    data: Mapped[str] = mapped_column(Text, default="{}")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)


class Broadcast(Base):
    """관리자가 모두에게 보낸 알림 — 로그인하지 않은 앱 사용자 휴대폰에도 감."""
    __tablename__ = "broadcasts"
    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(20), default="custom")     # custom / event / favorites
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(Text, default="")
    link: Mapped[str] = mapped_column(String(200), default="")
    sent: Mapped[int] = mapped_column(Integer, default=0)                # 앱 안 알림을 받은 사용자 수
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now, index=True)


class CollectLog(Base):
    __tablename__ = "collect_logs"
    id: Mapped[int] = mapped_column(primary_key=True)
    source: Mapped[str] = mapped_column(String(20))
    started_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    found: Mapped[int] = mapped_column(Integer, default=0)
    added: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str] = mapped_column(Text, default="")
