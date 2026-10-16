#!/usr/bin/env python3
import json, os, re, time, urllib.request, urllib.error, base64, pathlib

OUT = pathlib.Path("/workspace/pelican-bakeoff")
OUT.mkdir(parents=True, exist_ok=True)
BASE = "http://127.0.0.1:4096"
PASSWORD = os.environ.get("OPENCODE_SERVER_PASSWORD", "smoke-test-pass")
AUTH = base64.b64encode(f"opencode:{PASSWORD}".encode()).decode()

PROMPT = (
    "Create a single self-contained HTML document that draws a pelican riding a bicycle "
    "using only HTML and inline SVG (no external images, no JS required). The pelican should "
    "be recognizable (beak/pouch, body, wings) and clearly sitting on a bicycle with two wheels, "
    "frame, and pedals. Output ONLY the HTML document starting with <!DOCTYPE html> or <html — "
    "no markdown fences, no explanation."
)

MODELS = [
    ("opencode", "space-bunny-free", "free"),
    ("opencode", "mimo-v2.6-flash-free", "free"),
    ("opencode", "big-pickle", "free"),
    ("opencode", "nemotron-3.5-lightning-free", "free"),
    ("opencode", "muse-spark-1.3-contributor-free", "free"),
    ("opencode", "nemotron-3-ultra-free", "free"),
    ("opencode", "longcat-2.5-preview-free", "free"),
    ("opencode", "step-5-preview-free", "free"),
    ("opencode-go", "longcat-2.5-preview-free", "free"),
    ("opencode-go", "step-5-preview-free", "free"),
    ("opencode-go", "claude-haiku-5-5", "paid"),
]

def unwrap(x):
    if isinstance(x, dict) and "data" in x:
        return x["data"]
    return x

def req(method, path, body=None, timeout=300):
    data = None if body is None else json.dumps(body).encode()
    headers = {"Authorization": f"Basic {AUTH}", "Content-Type": "application/json"}
    r = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            raw = resp.read()
            code = resp.status
            if not raw:
                return code, None
            try:
                return code, json.loads(raw)
            except Exception:
                return code, raw.decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw
    except Exception as e:
        return 0, str(e)

def clean_html(text: str) -> str:
    m = re.search(r"```(?:html|HTML|svg|SVG)?\s*\n([\s\S]*?)```", text)
    if m:
        text = m.group(1)
    # sometimes multiple fences; take largest html-looking chunk
    idx = None
    for needle in ("<!DOCTYPE", "<!doctype", "<html", "<HTML"):
        i = text.find(needle)
        if i >= 0 and (idx is None or i < idx):
            idx = i
    if idx is not None:
        text = text[idx:]
    end = text.lower().rfind("</html>")
    if end >= 0:
        text = text[: end + 7]
    return text.strip()

def analyze(text: str):
    low = text.lower()
    has_svg = "<svg" in low
    has_html = ("<html" in low) or ("<!doctype" in low)
    notes = []
    for tag in ("circle", "ellipse", "path", "polygon", "rect", "line", "g"):
        if f"<{tag}" in low:
            notes.append(f"has_{tag}")
    if any(k in low for k in ("wheel", "bicycle", "bike", "pedal", "frame")):
        notes.append("bike_named")
    if any(k in low for k in ("pelican", "beak", "pouch", "wing")):
        notes.append("bird_named")
    if ("cx=" in low) and ("r=" in low):
        notes.append("wheel_like_attrs")
    if not has_svg and any(k in low for k in ("sorry", "cannot", "can't", "unable")):
        notes.append("looks_like_apology")
    notes.append(f"circle_count={low.count('<circle')}")
    notes.append(f"path_count={low.count('<path')}")
    notes.append(f"ellipse_count={low.count('<ellipse')}")
    notes.append(f"line_count={low.count('<line')}")
    return has_svg, has_html, notes

results_path = OUT / "results.jsonl"
# keep recovered entries? rewrite fresh but note recovered space-bunny will be retested
results_path.write_text("")
results = []

for provider, model, label in MODELS:
    safe = f"{provider}__{model}"
    print(f"=== Testing {provider}/{model} ({label}) ===", flush=True)
    t0 = time.time()
    rec = {
        "provider": provider,
        "model": model,
        "label": label,
        "latency_ms": 0,
        "ok": False,
        "error": None,
        "has_svg": False,
        "has_html": False,
        "approx_bytes": 0,
        "notes": "",
        "file": None,
        "method": "generate",
    }
    try:
        code, sess = req("POST", "/api/session", {
            "title": f"gen-pelican-{safe}",
            "model": {"id": model, "providerID": provider},
        })
        sess = unwrap(sess)
        if not isinstance(sess, dict) or not sess.get("id"):
            rec["error"] = f"create session failed: {code} {sess}"
            raise RuntimeError(rec["error"])
        sid = sess["id"]

        # ensure model set (create may already have it)
        code2, _ = req("POST", f"/api/session/{sid}/model", {"model": {"id": model, "providerID": provider}})
        if code2 not in (200, 204):
            # continue anyway if create had model
            pass

        code, resp = req("POST", f"/api/session/{sid}/generate", {"prompt": PROMPT}, timeout=300)
        data = unwrap(resp) if isinstance(resp, dict) else resp
        if code != 200:
            rec["error"] = f"generate HTTP {code}: {str(resp)[:500]}"
            raise RuntimeError(rec["error"])
        text = None
        if isinstance(data, dict):
            text = data.get("text") or data.get("content") or data.get("output")
            if not text and isinstance(data.get("message"), dict):
                text = data["message"].get("text")
        elif isinstance(data, str):
            text = data
        if not text:
            rec["error"] = f"generate empty: {str(resp)[:500]}"
            raise RuntimeError(rec["error"])

        (OUT / f"{safe}.raw.txt").write_text(text, encoding="utf-8")
        cleaned = clean_html(text)
        path = OUT / f"{safe}.html"
        path.write_text(cleaned, encoding="utf-8")
        has_svg, has_html, notes = analyze(cleaned)
        rec.update({
            "ok": True,
            "error": None,
            "has_svg": has_svg,
            "has_html": has_html,
            "approx_bytes": len(cleaned.encode()),
            "notes": ",".join(notes),
            "file": str(path),
        })
        print(
            f"OK ({int((time.time()-t0)*1000)} ms) bytes={rec['approx_bytes']} "
            f"svg={has_svg} html={has_html} notes={rec['notes']}",
            flush=True,
        )
    except Exception as e:
        if not rec["error"]:
            rec["error"] = str(e)[:800]
        print(f"FAIL ({int((time.time()-t0)*1000)} ms): {rec['error'][:250]}", flush=True)
    finally:
        rec["latency_ms"] = int((time.time() - t0) * 1000)
        results.append(rec)
        with results_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

print("DONE", flush=True)
print(json.dumps({
    "ok": sum(1 for r in results if r["ok"]),
    "fail": sum(1 for r in results if not r["ok"]),
    "total": len(results),
}))
