import json,base64,sys,urllib.request,websocket
url_match=sys.argv[1]; out=sys.argv[2]
clip=json.loads(sys.argv[3]) if len(sys.argv)>3 else None
tabs=json.load(urllib.request.urlopen("http://127.0.0.1:9224/json"))
t=[x for x in tabs if url_match in x.get("url","") and x["type"]=="page"][0]
ws=websocket.create_connection(t["webSocketDebuggerUrl"],timeout=60,suppress_origin=True)
i=[0]
def cmd(m,p=None):
    i[0]+=1;ws.send(json.dumps({"id":i[0],"method":m,"params":p or {}}))
    while True:
        r=json.loads(ws.recv())
        if r.get("id")==i[0]: return r
p={"format":"png","captureBeyondViewport":True}
if clip: p["clip"]=clip
r=cmd("Page.captureScreenshot",p)
open(out,"wb").write(base64.b64decode(r["result"]["data"]))
print("saved",out)
