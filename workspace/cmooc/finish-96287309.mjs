import { prisma } from "/workspace/grok-course-service-v1/lib/db.ts";
import {
  recordBrowserObservation,
  recordBrowserProposals,
  finishBrowserRun,
} from "/workspace/grok-course-service-v1/lib/workbench/browser-course-store.ts";
import { syncBrowserMiddleLayer } from "/workspace/grok-course-service-v1/lib/workbench/browser-middle-layer.ts";
import { readFileSync } from "node:fs";

const id = "96287309-6f2a-4892-8de7-4642232f0d00";
const wsRaw = JSON.parse(readFileSync("/workspace/grok-course-service-v1/.cmooc-service-data/browser-courses/workspace.json", "utf8"));
const raw = wsRaw.runs.find((r) => r.id === id);
if (!raw?.lease) throw new Error("NO_LEASE");
const own = raw.lease.owner;
const tok = raw.lease.token;
const base = "https://cmooc.bnu.edu.cn/cMOOC?courseId=2059235676645744640";
const u = (thread) => `${base}&thread=${thread}`;
const observedAt = "2026-09-19T13:05:00.000Z";
const observation = {
  courseUrl: base,
  observedAt,
  scope: "selected_discussions",
  complete: false,
  expectedDiscussions: null,
  coverageNote: "Partial selected discussions; distinct thread query params for projection",
  pages: [{ url: base, itemCount: 3, terminal: false }],
  discussions: [
    { ref: "disc_zhao", url: u("zhao"), title: "Zhao learner proposals", summary: "Learner proposals; multiple human replies; agent touch cap 2/2", complete: false },
    { ref: "disc_guan", url: u("guan"), title: "Guan learner proposal", summary: "Learner proposal; prior human substantive reply present", complete: false },
    { ref: "disc_liu_cold", url: u("liu"), title: "Liu cold digital-transform post", summary: "Cold learner post with 0 comments; hold without draft this beat", complete: false },
  ],
  posts: [
    { ref: "post_zhao", discussionRef: "disc_zhao", parentRef: null, actorAlias: "ZX01", role: "learner", createdAt: "2025-11-28T14:17:00.000Z", url: u("zhao") },
    { ref: "reply_zhao_peer", discussionRef: "disc_zhao", parentRef: "post_zhao", actorAlias: "WG01", role: "learner", createdAt: "2026-07-18T00:00:00.000Z", url: u("zhao") },
    { ref: "post_guan", discussionRef: "disc_guan", parentRef: null, actorAlias: "GF01", role: "learner", createdAt: "2025-05-01T00:00:00.000Z", url: u("guan") },
    { ref: "reply_guan_wg", discussionRef: "disc_guan", parentRef: "post_guan", actorAlias: "WG01", role: "learner", createdAt: "2026-07-18T00:00:00.000Z", url: u("guan") },
    { ref: "post_liu_cold", discussionRef: "disc_liu_cold", parentRef: null, actorAlias: "LS01", role: "learner", createdAt: "2026-01-01T00:00:00.000Z", url: u("liu") },
  ],
};
const proposals = [
  { discussionRef: "disc_zhao", decision: "YIELD", reason: "Human peer replies present; agent touch cap 2/2; yield", draft: "", intent: { function: "peer_connection", evidenceRefs: ["reply_zhao_peer"], responsibility: "peer", alternative: "Leave thread to existing human peer replies", expectedProcess: "Humans already engaged; companion does not add another touch", yieldCondition: "Human substantive replies already present" } },
  { discussionRef: "disc_guan", decision: "YIELD", reason: "Prior human substantive reply present; yield", draft: "", intent: { function: "peer_connection", evidenceRefs: ["reply_guan_wg"], responsibility: "peer", alternative: "Leave thread to existing human peer reply", expectedProcess: "Human peer already engaged; no companion reply", yieldCondition: "Human substantive reply already present" } },
  { discussionRef: "disc_liu_cold", decision: "WAIT", reason: "Cold post 0 comments; hold without draft; no post this beat", draft: "", intent: { function: "peer_connection", evidenceRefs: ["post_liu_cold"], responsibility: "companion", alternative: "Hold without draft this beat", expectedProcess: "Cold post with 0 comments; observe only under daily budget", yieldCondition: "Third-party catch arrives or facilitation budget opens" } },
];

try {
  await recordBrowserObservation(id, own, tok, observation, "portable-fix-urls-obs5");
  console.log("obs ok");
  await recordBrowserProposals(id, own, tok, proposals, "portable-fix-urls-prop5");
  console.log("prop ok");
  await syncBrowserMiddleLayer(prisma, id);
  console.log("sync ok");
  const finished = await finishBrowserRun(
    id,
    own,
    tok,
    "Portable smoke closed: Zhao YIELD / Guan YIELD / Liu cold WAIT; overall WAIT; no publish; hard lock remains off.",
  );
  console.log("finish", finished.status);
  console.log("tape", finished.tape.map((e) => [e.seq, e.kind]));
  console.log("summary", finished.summary);
} catch (e) {
  console.error("FAIL", e?.code || "", e?.message || e);
  console.error((e?.stack || "").split("\n").slice(0, 40).join("\n"));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
