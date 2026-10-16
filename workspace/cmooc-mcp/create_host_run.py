import json, uuid, urllib.request
from pathlib import Path
origin = "http://127.0.0.1:3017"
course_id = "d5893188-85fe-46a8-b85d-607b8085ad45"
body = {
    "action": "run",
    "courseId": course_id,
    "requestId": str(uuid.uuid4()),
    "mode": "observe",
    "executor": "codex_host",
    "goal": "真课一拍：观察讨论，四态判定；有站立许可再考虑回帖回执。",
}
req = urllib.request.Request(
    origin + "/api/workbench/browser-courses",
    data=json.dumps(body, ensure_ascii=False).encode(),
    headers={"Content-Type": "application/json", "Origin": origin},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        print("POST", r.status)
        print(r.read().decode())
except Exception as e:
    detail = e.read().decode() if hasattr(e, "read") else ""
    print("ERR", e, detail)
req2 = urllib.request.Request(origin + "/api/workbench/browser-courses", headers={"Origin": origin})
with urllib.request.urlopen(req2, timeout=20) as r:
    data = json.loads(r.read().decode())
    print("RUNS", json.dumps(data.get("runs"), ensure_ascii=False, indent=2)[:2000])
