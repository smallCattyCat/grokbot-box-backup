import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkbenchFocusHref,
  parseBriefFocus,
  serializeBriefFocus
} from "../../lib/workbench/agent-native-contracts";

test("brief focus round-trips through the URL namespace", () => {
  const serialized = serializeBriefFocus("decision:focus-01");

  assert.equal(serialized, "brief:decision:focus-01");
  assert.equal(parseBriefFocus(serialized), "decision:focus-01");
});

test("focus href preserves run and replaces only the Workbench focus", () => {
  const href = buildWorkbenchFocusHref({
    searchParams: new URLSearchParams("run=run-01&focus=brief:old&view=conversation"),
    focusId: "decision:new"
  });
  const params = new URL(href, "https://cmooc.local").searchParams;

  assert.equal(params.get("run"), "run-01");
  assert.equal(params.get("view"), "conversation");
  assert.equal(parseBriefFocus(params.get("focus")), "decision:new");
});

test("invalid focus is rejected and closing clears focus without losing other query state", () => {
  assert.equal(parseBriefFocus("brief:bad%2Fid"), null);
  assert.equal(serializeBriefFocus("bad/id"), null);

  const href = buildWorkbenchFocusHref({
    searchParams: new URLSearchParams("run=run-02&focus=brief:old"),
    focusId: null
  });
  const params = new URL(href, "https://cmooc.local").searchParams;

  assert.equal(params.get("run"), "run-02");
  assert.equal(params.get("focus"), null);
});
