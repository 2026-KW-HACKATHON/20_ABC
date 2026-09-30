"""보행로 노드 고도를 받아 경사도(배리어프리 경로)에 반영합니다.
실행: cd server && python -m tools.fetch_elevation
"""
import json

from app.services.osm_update import fetch_elevation

if __name__ == "__main__":
    print(json.dumps(fetch_elevation(), ensure_ascii=False, indent=2))
