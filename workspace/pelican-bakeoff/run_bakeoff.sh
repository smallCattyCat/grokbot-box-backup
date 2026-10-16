#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.opencode/bin:$PATH"
AUTH="opencode:${OPENCODE_SERVER_PASSWORD:-smoke-test-pass}"
BASE="http://127.0.0.1:4096"
OUT="/workspace/pelican-bakeoff"
mkdir -p "$OUT"
: > "$OUT/results.jsonl"

PROMPT='Create a single self-contained HTML document that draws a pelican riding a bicycle using only HTML and inline SVG (no external images, no JS required). The pelican should be recognizable (beak/pouch, body, wings) and clearly sitting on a bicycle with two wheels, frame, and pedals. Output ONLY the HTML document starting with <!DOCTYPE html> or <html — no markdown fences, no explanation.'

# provider|model|label
MODELS=(
  "opencode|space-bunny-free|free"
  "opencode|mimo-v2.6-flash-free|free"
  "opencode|big-pickle|free"
  "opencode|nemotron-3.5-lightning-free|free"
  "opencode|muse-spark-1.3-contributor-free|free"
  "opencode|nemotron-3-ultra-free|free"
  "opencode|longcat-2.5-preview-free|free"
  "opencode|step-5-preview-free|free"
  "opencode-go|longcat-2.5-preview-free|free"
  "opencode-go|step-5-preview-free|free"
  "opencode-go|claude-haiku-5-5|paid"
)

strip_fences() {
  local text="$1"
  # Remove markdown code fences if present
  if echo "$text" | grep -q '```'; then
    # extract content between first ```... and closing ```
    text=$(echo "$text" | sed -n '/^```/,/^```/p' | sed '1d;$d')
  fi
  # Also try to find from <!DOCTYPE or <html
  if ! echo "$text" | grep -qi '<!DOCTYPE\|<html'; then
    echo "$text"
    return
  fi
  # Keep from first html-ish start to end
  echo "$text" | awk 'BEGIN{p=0} tolower($0) ~ /<!doctype|<html/{p=1} p{print}'
}

extract_assistant_text() {
  local json="$1"
  python3 - "$json" <<'PY'
import json,sys
raw=open(sys.argv[1]).read() if False else None
data=json.load(sys.stdin) if False else None
PY
}

for entry in "${MODELS[@]}"; do
  IFS='|' read -r PROVIDER MODEL LABEL <<< "$entry"
  SAFE="${PROVIDER}__${MODEL}"
  echo "=== Testing $PROVIDER / $MODEL ($LABEL) ===" >&2
  START=$(date +%s%3N)
  OK=false
  ERR=""
  TEXT=""
  HAS_SVG=false
  HAS_HTML=false
  BYTES=0
  NOTES=""

  # Create session
  SID=$(curl -s -u "$AUTH" -H 'Content-Type: application/json' \
    -d "{\"title\":\"pelican-$SAFE\"}" \
    "$BASE/api/session" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || true)
  if [[ -z "$SID" ]]; then
    ERR="failed to create session"
    END=$(date +%s%3N)
    LAT=$((END-START))
    python3 -c "import json; print(json.dumps({'provider':'$PROVIDER','model':'$MODEL','label':'$LABEL','latency_ms':$LAT,'ok':False,'error':'$ERR','has_svg':False,'has_html':False,'approx_bytes':0,'notes':'','file':None}))" >> "$OUT/results.jsonl"
    echo "FAIL: $ERR" >&2
    continue
  fi

  # Set model
  CODE=$(curl -s -o /tmp/oc-model-resp.txt -w "%{http_code}" -u "$AUTH" -H 'Content-Type: application/json' \
    -d "{\"model\":{\"id\":\"$MODEL\",\"providerID\":\"$PROVIDER\"}}" \
    "$BASE/api/session/$SID/model")
  if [[ "$CODE" != "204" && "$CODE" != "200" ]]; then
    ERR="set model HTTP $CODE: $(head -c 200 /tmp/oc-model-resp.txt)"
    END=$(date +%s%3N)
    LAT=$((END-START))
    python3 -c "import json; print(json.dumps({'provider':'$PROVIDER','model':'$MODEL','label':'$LABEL','latency_ms':$LAT,'ok':False,'error':'''$ERR''','has_svg':False,'has_html':False,'approx_bytes':0,'notes':'','file':None}, ensure_ascii=False))" >> "$OUT/results.jsonl"
    echo "FAIL: $ERR" >&2
    continue
  fi

  # Prompt
  curl -s -u "$AUTH" -H 'Content-Type: application/json' \
    -d "$(python3 -c "import json; print(json.dumps({'text':'''$PROMPT'''}))" 2>/dev/null || echo "{\"text\":$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$PROMPT")})" \
    "$BASE/api/session/$SID/prompt" > /tmp/oc-prompt-resp.json || true

  # Better prompt send
  python3 - <<PY > /tmp/oc-prompt-body.json
import json
print(json.dumps({"text": """$PROMPT"""}))
PY
  curl -s -u "$AUTH" -H 'Content-Type: application/json' \
    -d @/tmp/oc-prompt-body.json \
    "$BASE/api/session/$SID/prompt" > /tmp/oc-prompt-resp.json

  # Poll for assistant message
  TEXT=""
  ERR_MSG=""
  for i in $(seq 1 90); do
    sleep 2
    curl -s -u "$AUTH" "$BASE/api/session/$SID/message" > /tmp/oc-msgs.json
    RESULT=$(python3 <<'PY'
import json
try:
    msgs=json.load(open("/tmp/oc-msgs.json"))
except Exception as e:
    print("WAIT")
    raise SystemExit
if isinstance(msgs, dict):
    msgs=msgs.get("data") or msgs.get("messages") or msgs.get("items") or []
if not isinstance(msgs, list):
    print("WAIT")
    raise SystemExit
# find last assistant
for m in reversed(msgs):
    role=(m.get("info") or {}).get("role") or m.get("role") or ""
    if role != "assistant":
        continue
    # check error
    err=(m.get("info") or {}).get("error") or m.get("error")
    if err:
        print("ERR:"+json.dumps(err)[:500])
        raise SystemExit
    parts=m.get("parts") or m.get("content") or []
    texts=[]
    for p in parts:
        t=p.get("type")
        if t=="text" and p.get("text"):
            texts.append(p["text"])
        elif t=="error" or p.get("error"):
            print("ERR:"+str(p)[:500])
            raise SystemExit
    # also check finish/status
    status=(m.get("info") or {}).get("status") or m.get("status") or ""
    finish=(m.get("info") or {}).get("finish") or ""
    if texts:
        open("/tmp/oc-assistant.txt","w").write("\n".join(texts))
        print("OK")
        raise SystemExit
    # if completed with no text
    if status in ("complete","completed","error") or finish:
        if err:
            print("ERR:"+str(err)[:500])
        else:
            print("ERR:empty assistant")
        raise SystemExit
print("WAIT")
PY
)
    if [[ "$RESULT" == "OK" ]]; then
      TEXT=$(cat /tmp/oc-assistant.txt)
      OK=true
      break
    elif [[ "$RESULT" == ERR:* ]]; then
      ERR_MSG="${RESULT#ERR:}"
      break
    fi
  done

  END=$(date +%s%3N)
  LAT=$((END-START))

  if [[ "$OK" != true ]]; then
    ERR="${ERR_MSG:-timeout or no response}"
    python3 -c "import json; print(json.dumps({'provider':'$PROVIDER','model':'$MODEL','label':'$LABEL','latency_ms':$LAT,'ok':False,'error':json.loads(open('/dev/stdin').read()) if False else '''$(echo "$ERR" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))")''','has_svg':False,'has_html':False,'approx_bytes':0,'notes':'','file':None}, ensure_ascii=False))" 2>/dev/null || \
    python3 <<PY >> "$OUT/results.jsonl"
import json
print(json.dumps({
  "provider":"$PROVIDER","model":"$MODEL","label":"$LABEL",
  "latency_ms":$LAT,"ok":False,"error":"""$ERR""",
  "has_svg":False,"has_html":False,"approx_bytes":0,"notes":"","file":None
}, ensure_ascii=False))
PY
    echo "FAIL ($LAT ms): $ERR" >&2
    continue
  fi

  # Strip fences and save
  python3 <<PY
import re, json, os
text=open("/tmp/oc-assistant.txt").read()
# strip fences
m=re.search(r"```(?:html|HTML|svg|SVG)?\s*\n([\s\S]*?)```", text)
if m:
    text=m.group(1)
# find html start
idx=None
for needle in ("<!DOCTYPE", "<!doctype", "<html", "<HTML"):
    i=text.find(needle)
    if i>=0 and (idx is None or i<idx):
        idx=i
if idx is not None:
    text=text[idx:]
# trim trailing explanation after </html>
end=text.lower().rfind("</html>")
if end>=0:
    text=text[:end+7]
path="/workspace/pelican-bakeoff/${SAFE}.html"
open(path,"w").write(text)
has_svg="<svg" in text.lower()
has_html=("<html" in text.lower()) or ("<!doctype" in text.lower())
# structural notes
notes=[]
low=text.lower()
if "circle" in low: notes.append("has_circle")
if "ellipse" in low: notes.append("has_ellipse")
if "path" in low: notes.append("has_path")
if "polygon" in low: notes.append("has_polygon")
if "rect" in low: notes.append("has_rect")
if "wheel" in low or "bicycle" in low or "bike" in low: notes.append("bike_named")
if "pelican" in low or "beak" in low or "pouch" in low: notes.append("bird_named")
# apology detection
if not has_svg and ("sorry" in low or "cannot" in low or "can't" in low):
    notes.append("looks_like_apology")
if has_svg and ("cx=" in low or "r=" in low):
    notes.append("wheel_like_attrs")
print(json.dumps({
  "provider":"$PROVIDER","model":"$MODEL","label":"$LABEL",
  "latency_ms":$LAT,"ok":True,"error":None,
  "has_svg":has_svg,"has_html":has_html,
  "approx_bytes":len(text.encode()),
  "notes":",".join(notes),
  "file":path
}, ensure_ascii=False))
PY
  >> "$OUT/results.jsonl"
  echo "OK ($LAT ms) -> $OUT/${SAFE}.html" >&2
done

echo "DONE" >&2
