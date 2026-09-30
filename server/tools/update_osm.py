"""OpenStreetMap 에서 월계1동 지도를 새로 받습니다.
실행: cd server && python -m tools.update_osm
"""
import json

from app.services.osm_update import update_osm

if __name__ == "__main__":
    print(json.dumps(update_osm(), ensure_ascii=False, indent=2))
