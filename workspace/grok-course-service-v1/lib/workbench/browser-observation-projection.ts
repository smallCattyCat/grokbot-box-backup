import { browserProjectionDecisionPayload } from "./browser-projection-identity";
import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { canonicalProtocolHash, type CanonicalJsonValue } from "@/lib/facilitation-protocol";
import { loadOrCreateLocalEvidenceSecret, localEvidenceHmac } from "@/lib/privacy/local-evidence-hmac";
import { CANDIDATE_SET_SCHEMA_VERSION, type AutonomyCandidate, type AutonomyCandidateSet } from "@/lib/autonomy/candidate-set";
import { appendDecisionTapeEntry } from "@/lib/autonomy/decision-tape";
import { canonicalBrowserCourseUrl, type BrowserCourse, type BrowserCourseRun } from "./browser-course-contracts";

const hash = (schema: string, value: unknown) => canonicalProtocolHash(schema, value as CanonicalJsonValue);
export const BROWSER_WORLD_SCHEMA = "browser.observed-world.v1";
export const BROWSER_GRAPH_SCHEMA = "browser.observed-graph.v1";
export type BrowserProjectionResult = {
  courseAlias: string; invocationId: string; worldSnapshotId: string; graphSnapshotId: string;
  candidateSetId: string; replayed: boolean;
  decisionMappings: Array<{ discussionRef: string; threadKey: string; decisionKey: string; candidateKey: string }>;
};

/** Server-only bridge. Input must be reread from the validated private Browser store.
 * It persists visible structure, never invents a missing root/time, and never
 * registers a scheduled worker or an execution capability. */
export async function projectBrowserObservation(input: {
  prisma: PrismaClient; course: BrowserCourse; run: BrowserCourseRun; identitySecret?: Buffer | string;
}): Promise<BrowserProjectionResult> {
  const { prisma, course, run } = input;
  const observation = run.observation;
  if (run.courseId !== course.id || !observation || canonicalBrowserCourseUrl(observation.courseUrl) !== canonicalBrowserCourseUrl(course.entryUrl)) throw new Error("BROWSER_PROJECTION_SCOPE");
  if (run.proposals.length !== observation.discussions.length || new Set(run.proposals.map(p => p.discussionRef)).size !== observation.discussions.length ||
      observation.discussions.some(d => !run.proposals.some(p => p.discussionRef === d.ref))) throw new Error("BROWSER_PROJECTION_DECISIONS_MISSING");
  const observedAt = new Date(observation.observedAt);
  if (!Number.isFinite(observedAt.getTime()) || observedAt.getTime() > Date.now() + 60_000) throw new Error("BROWSER_PROJECTION_TIME");
  if (observation.posts.some(p => p.createdAt && (!Number.isFinite(Date.parse(p.createdAt)) || Date.parse(p.createdAt) > observedAt.getTime()))) throw new Error("BROWSER_PROJECTION_POST_TIME");
  const secret = input.identitySecret ?? await loadOrCreateLocalEvidenceSecret();
  const hmac = (scope: string, value: string) => localEvidenceHmac({ secret, scope, value, length: 64 });
  const canonicalLocatorHash = hmac("autonomy-manifest-locator-v1", canonicalBrowserCourseUrl(course.entryUrl));
  const identityKeyFingerprint = createHash("sha256").update(secret).digest("hex");
  const courseAlias = `browser-${canonicalLocatorHash.slice(0, 40)}`;
  // A displayed actor alias has observation-local identity only. Never merge it
  // into a longitudinal learner identity or claim an authenticated role registry.
  const observationHash = hmac("browser-observation-v1", JSON.stringify(observation));
  const proposalHash = hmac("browser-proposals-v1", JSON.stringify(browserProjectionDecisionPayload(run.proposals)));
  const runHash = hmac("browser-run-v1", run.id);
  const projectKey = hash("browser.projection.v1", { canonicalLocatorHash, observationHash, proposalHash, runHash });
  const threadKeyFor = (ref: string) => {
    const d = observation.discussions.find(d => d.ref === ref)!;
    return hmac("browser-thread-v1", `${canonicalLocatorHash}:${d.url}`);
  };
  const eventKeyFor = (ref: string) => hmac("browser-visible-post-v1", `${observationHash}:${ref}`);
  const actorKeyFor = (alias: string) => hmac("browser-visible-actor-v1", `${observationHash}:${alias}`);
  const posts = observation.posts.map(p => ({
    eventKey: eventKeyFor(p.ref), threadKey: threadKeyFor(p.discussionRef), actorKey: actorKeyFor(p.actorAlias),
    parentEventKey: p.parentRef && observation.posts.some(parent => parent.ref === p.parentRef && parent.discussionRef === p.discussionRef) ? eventKeyFor(p.parentRef) : null,
    parentStatus: p.parentRef === null ? "root_reported" : observation.posts.some(parent => parent.ref === p.parentRef && parent.discussionRef === p.discussionRef) ? "visible" : "unresolved",
    createdAt: p.createdAt, observedAt: observation.observedAt, reportedRole: p.role
  }));
  const edges = posts.filter(p => p.parentStatus === "visible").map(p => ({ source: p.eventKey, target: p.parentEventKey, relation: "visible_parent", temporalOrder: "not_inferred" }));
  const actors = [...new Set(posts.map(p => p.actorKey))];
  const coverage = { evidenceOrigin: course.source === "local_fixture" ? "local_fixture" : "browser_reported_observation", scope: observation.scope, complete: observation.complete, expectedDiscussions: observation.expectedDiscussions,
    observedDiscussions: observation.discussions.length, observedPosts: posts.length,
    identityBasis: "observation_local_alias", graphCountBasis: "lower_bound", containsForumText: false };
  const coverageHash = hash("browser.projection-coverage.v1", coverage);
  const graph = { schemaVersion: BROWSER_GRAPH_SCHEMA, observedAt: observation.observedAt,
    nodes: posts.map(p => ({ eventKey: p.eventKey, actorKey: p.actorKey, threadKey: p.threadKey })), edges,
    coverage, containsForumText: false };
  const graphHash = hash(BROWSER_GRAPH_SCHEMA, graph);
  const eventSetHash = hash("browser.visible-post-set.v1", posts);
  const receipts = observation.discussions.map(d => ({ schemaVersion: "browser.observation-receipt.v1",
    runHash, projectKey, threadKey: threadKeyFor(d.ref), observedAt: observation.observedAt,
    observationHash, discussionComplete: d.complete, posts: posts.filter(p => p.threadKey === threadKeyFor(d.ref)),
    coverage, containsForumText: false }));
  const candidates: AutonomyCandidate[] = observation.discussions.map((d, index) => {
    const visible = posts.filter(p => p.threadKey === threadKeyFor(d.ref));
    const roots = visible.filter(p => p.parentStatus === "root_reported");
    const root = roots.length === 1 ? roots[0] : null;
    const allTimesKnown = visible.length > 0 && visible.every(p => !!p.createdAt);
    const complete = d.complete && !!root && allTimesKnown && visible.every(p => p.parentStatus !== "unresolved" && p.reportedRole !== "unknown");
    const times = visible.flatMap(p => p.createdAt ? [p.createdAt] : []).sort();
    const payload = {
      threadKey: threadKeyFor(d.ref), authorKey: root?.actorKey ?? null, rootEventKey: root?.eventKey ?? null,
      targetVersionHash: hash("browser.visible-discussion.v1", visible),
      contributionPublishedAt: root?.createdAt ?? null, latestEventAt: allTimesKnown ? times.at(-1)! : null,
      eventCount: visible.length,
      externalHumanCount: root ? visible.filter(p => p.parentStatus !== "root_reported" && p.actorKey !== root.actorKey && ["learner", "teacher"].includes(p.reportedRole)).length : 0,
      authorReturnCount: root ? visible.filter(p => p.parentStatus !== "root_reported" && p.actorKey === root.actorKey).length : 0,
      systemResponseCount: visible.filter(p => p.parentStatus !== "root_reported" && p.reportedRole === "agent").length,
      // A reply may resolve or change the need. No semantic support-gap clock
      // can be inferred from visible reply timestamps alone.
      supportGapHours: complete && visible.length === 1 && root?.createdAt ? Math.max(0, Math.floor((observedAt.getTime() - Date.parse(root.createdAt)) / 3_600_000)) : null,
      completeness: complete ? "complete" as const : "censored" as const,
      sourceObservationReceiptHash: hash(receipts[index].schemaVersion, receipts[index])
    };
    return { ...payload, candidateKey: hash("cmooc.autonomy-candidate.v1", payload) };
  });
  const world = { schemaVersion: BROWSER_WORLD_SCHEMA, observedAt: observation.observedAt, posts,
    discussions: candidates.map(c => ({ threadKey: c.threadKey, rootEventKey: c.rootEventKey, completeness: c.completeness,
      missingRoot: c.rootEventKey === null, missingTime: c.contributionPublishedAt === null || c.latestEventAt === null })),
    coverage, graphHash, eventSetHash, gapCountBasis: "complete_threads_with_no_observed_replies",
    containsForumText: false };
  const worldHash = hash(BROWSER_WORLD_SCHEMA, world);
  const manifestHash = hash("browser.manual-shadow-manifest.v1", { canonicalLocatorHash, identityKeyFingerprint, mode: "SHADOW", source: "browser_manual", realPublishEnabled: false });
  return prisma.$transaction(async tx => {
    const matching = await tx.autonomyCourseManifest.findMany({ where: { canonicalLocatorHash, identityKeyFingerprint }, take: 2 });
    if (matching.length > 1) throw new Error("BROWSER_PROJECTION_MANIFEST_AMBIGUOUS");
    if (matching[0]?.enabled === false) throw new Error("BROWSER_PROJECTION_MANIFEST_DISABLED");
    const alias = matching[0]?.alias ?? courseAlias;
    const boundManifestHash = matching[0]?.manifestHash ?? manifestHash;
    if (!matching.length) await tx.autonomyCourseManifest.create({ data: {
      alias, manifestHash, platformId: "browser.manual", adapterId: "browser.observation.projection.v1",
      platformCourseRefHash: canonicalLocatorHash, canonicalLocatorHash, identityKeyFingerprint,
      allowedOrigin: new URL(course.entryUrl).origin, timeZone: "Asia/Shanghai", defaultMode: "SHADOW",
      policyVersion: "browser.manual-shadow.v1", enabled: true, realPublishEnabled: false
    } });
    const prior = await tx.scheduledInvocation.findUnique({ where: { invocationKey: projectKey } });
    const mappings = candidates.map((c, index) => ({ discussionRef: observation.discussions[index].ref, threadKey: c.threadKey,
      candidateKey: c.candidateKey, decisionKey: hash("browser.projection-decision.v1", { projectKey, candidateKey: c.candidateKey }) }));
    if (prior) {
      const [w, g, set, decisions] = await Promise.all([
        tx.courseWorldSnapshot.findUnique({ where: { invocationId: prior.id } }),
        tx.courseContentGraphSnapshot.findFirst({ where: { worldSnapshot: { invocationId: prior.id }, schemaVersion: BROWSER_GRAPH_SCHEMA } }),
        tx.candidateSet.findUnique({ where: { invocationId: prior.id } }),
        tx.autonomyDecision.findMany({ where: { invocationId: prior.id } })
      ]);
      if (!w || !g || !set || w.worldHash !== worldHash || decisions.length !== mappings.length || mappings.some(m => !decisions.some(d => d.decisionKey === m.decisionKey))) throw new Error("BROWSER_PROJECTION_REPLAY_MISMATCH");
      return { courseAlias: alias, invocationId: prior.id, worldSnapshotId: w.id, graphSnapshotId: g.id, candidateSetId: set.id, decisionMappings: mappings, replayed: true };
    }
    if (await tx.scheduledInvocation.findUnique({ where: { courseAlias_scheduledFor_mode: { courseAlias: alias, scheduledFor: observedAt, mode: "SHADOW" } } })) throw new Error("BROWSER_PROJECTION_ASOF_CONFLICT");
    const invocation = await tx.scheduledInvocation.create({ data: {
      invocationKey: projectKey, courseAlias: alias, manifestHash: boundManifestHash, scheduledFor: observedAt,
      mode: "SHADOW", status: "completed", phase: "browser_projection", finishedAt: new Date(),
      summaryJson: JSON.stringify({ source: "browser_projection", observationHash, proposalHash, projectionKey: projectKey, publishAttemptCount: 0, containsForumText: false })
    } });
    const snapshot = await tx.courseWorldSnapshot.create({ data: {
      invocationId: invocation.id, courseAlias: alias, asOfAt: observedAt, eventSetHash, worldHash, graphHash, coverageHash,
      eventCount: posts.length, threadCount: candidates.length, actorCount: actors.length, edgeCount: edges.length,
      openGapCount: candidates.filter(c => c.completeness === "complete" && c.eventCount === 1).length,
      stateJson: JSON.stringify(world)
    } });
    const graphRow = await tx.courseContentGraphSnapshot.create({ data: {
      worldSnapshotId: snapshot.id, courseAlias: alias, asOfAt: observedAt, schemaVersion: BROWSER_GRAPH_SCHEMA,
      structureFactSetHash: hash("browser.visible-structure.v1", { graph }), nodeSetHash: hash("browser.visible-nodes.v1", graph.nodes),
      edgeSetHash: hash("browser.visible-edges.v1", edges), contentGraphHash: graphHash, coverageHash,
      coverageStatus: "lower_bound", roleRegistryStatus: "unavailable", nodeCount: posts.length, edgeCount: edges.length,
      learnerNodeCount: new Set(posts.filter(p => p.reportedRole === "learner").map(p => p.actorKey)).size, stateJson: JSON.stringify(graph)
    } });
    const set: AutonomyCandidateSet = { schemaVersion: CANDIDATE_SET_SCHEMA_VERSION, courseAlias: alias, worldHash, eventSetHash,
      asOfAt: observation.observedAt, candidates, containsForumText: false };
    const candidateSetHash = hash(set.schemaVersion, set);
    const setRow = await tx.candidateSet.create({ data: { invocationId: invocation.id, snapshotId: snapshot.id,
      candidateSetHash, asOfAt: observedAt, candidateCount: candidates.length, candidatesJson: JSON.stringify(set) } });
    for (const [index, c] of candidates.entries()) {
      const receipt = receipts[index];
      await tx.autonomyObservation.create({ data: { invocationId: invocation.id, threadKey: c.threadKey,
        receiptHash: c.sourceObservationReceiptHash, observedAt, receiptJson: JSON.stringify(receipt), containsForumText: false } });
      const proposal = run.proposals.find(p => p.discussionRef === observation.discussions[index].ref)!;
      const decision = (c.completeness === "complete" ? proposal.decision : "ABSTAIN").toLowerCase();
      const reasonCode = c.completeness === "complete" ? "browser_projection_server_decision" : "browser_projection_incomplete_evidence";
      const payload = { schemaVersion: "browser.projected-decision.v1", source: "browser_projection", decision,
        reasonCode, candidateKey: c.candidateKey, worldHash, candidateSetHash, graphHash,
        evidenceAsOf: observation.observedAt, proposalHash, publishAllowed: false, editorWriteAllowed: false, containsForumText: false };
      const evidenceHash = hash(payload.schemaVersion, payload);
      await tx.autonomyDecision.create({ data: { invocationId: invocation.id, courseAlias: alias,
        decisionKey: mappings[index].decisionKey, threadKey: c.threadKey, authorKey: c.authorKey, decision,
        decisionMode: "SHADOW", reasonCode, observationReceiptHash: c.sourceObservationReceiptHash,
        opportunityReceiptHash: evidenceHash, evidenceBundleHash: evidenceHash, policyVersion: "browser.manual-shadow.v1",
        worldHash, candidateSetHash, evidenceAsOf: observedAt, decisionJson: JSON.stringify(payload),
        bodyPersisted: false, publishAttempted: false, editorWriteAttempted: false } });
    }
    await appendDecisionTapeEntry({ prisma: tx, invocationId: invocation.id, kind: "browser_projection", payload: {
      schemaVersion: "browser.projection-receipt.v1", source: "browser_projection", projectionKey: projectKey,
      observationHash, proposalHash, worldHash, graphHash, candidateSetHash, coverageHash,
      observedAt: observation.observedAt, projectedAt: new Date().toISOString(),
      autonomyTickExecuted: false, scheduleCreated: false, realPublishEnabled: false, containsForumText: false
    } });
    return { courseAlias: alias, invocationId: invocation.id, worldSnapshotId: snapshot.id, graphSnapshotId: graphRow.id,
      candidateSetId: setRow.id, decisionMappings: mappings, replayed: false };
  }, { maxWait: 10_000, timeout: 20_000 });
}
