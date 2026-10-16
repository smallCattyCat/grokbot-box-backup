import json, urllib.request
from pathlib import Path
key_path = Path("/workspace/cmooc/.localappdata/cmooc-workbench/browser-courses/915c5e3de41ac987ca5d/bridge-key")
key = key_path.read_text().strip()
origin = "http://127.0.0.1:3017"
body = {
    "action": "add",
    "course": {
        "title": "生成式课程的设计与实施（常态公开课）",
        "entryUrl": "https://cmooc.bnu.edu.cn/cMOOC?courseId=2059235676645744640",
        "platformLabel": "北师大cMOOC",
        "goal": "看看本周的讨论，帮助还没有得到回应的学习者。",
        "budget": 3,
    },
}
req = urllib.request.Request(
    origin + "/api/workbench/browser-courses",
    data=json.dumps(body, ensure_ascii=False).encode(),
    headers={"Content-Type": "application/json", "Origin": origin},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=20) as r:
        print("POST", r.status, r.read().decode())
except Exception as e:
    detail = e.read().decode() if hasattr(e, "read") else ""
    print("POST_ERR", e, detail)
req2 = urllib.request.Request(origin + "/api/workbench/browser-courses", headers={"Origin": origin})
with urllib.request.urlopen(req2, timeout=20) as r:
    print("GET", r.read().decode())
