import type { Prisma, PrismaClient } from "@prisma/client";
import { canonicalProtocolHash, type CanonicalJsonValue } from "@/lib/facilitation-protocol";
import { parseCommunityInquiryMemoryProjection } from "./inquiry-memory";
import type { CommunityInquiryShadowDecision } from "./shadow-comparison";
import { CANDIDATE_SET_SCHEMA_VERSION, type AutonomyCandidateSet } from "@/lib/autonomy/candidate-set";

/** Resolve a decision from persisted evidence, never from browser-supplied anchors. */
export async function loadExperienceDecisionContext(prisma: PrismaClient | Prisma.TransactionClient, courseAlias: string, decisionKey: string) {
  const decision = await prisma.autonomyDecision.findUnique({ where: { decisionKey } });
  if (!decision || decision.courseAlias !== courseAlias) throw new Error("EXPERIENCE_DECISION_SCOPE");
  const [world, candidateRow] = await Promise.all([
    prisma.courseWorldSnapshot.findUnique({ where: { invocationId: decision.invocationId } }),
    prisma.candidateSet.findUnique({ where: { invocationId: decision.invocationId } })
  ]);
  if (!world || !candidateRow) throw new Error("EXPERIENCE_CONTEXT_UNAVAILABLE");
  const graphs = await prisma.courseContentGraphSnapshot.findMany({ where: { worldSnapshotId: world.id }, take: 2 });
  if (graphs.length !== 1) throw new Error("EXPERIENCE_GRAPH_AMBIGUOUS");
  const graph = graphs[0];
  const set = JSON.parse(candidateRow.candidatesJson) as AutonomyCandidateSet;
  if (set.schemaVersion !== CANDIDATE_SET_SCHEMA_VERSION || !Array.isArray(set.candidates) ||
      canonicalProtocolHash(set.schemaVersion, set as unknown as CanonicalJsonValue) !== candidateRow.candidateSetHash ||
      set.courseAlias !== courseAlias || world.courseAlias !== courseAlias || graph.courseAlias !== courseAlias ||
      set.worldHash !== world.worldHash || decision.worldHash !== world.worldHash ||
      candidateRow.snapshotId !== world.id || decision.candidateSetHash !== candidateRow.candidateSetHash ||
      [set.asOfAt, graph.asOfAt.toISOString(), candidateRow.asOfAt.toISOString()]
        .some(at => at !== world.asOfAt.toISOString())) throw new Error("EXPERIENCE_CONTEXT_MISMATCH");
  const candidates = set.candidates.filter(candidate => candidate.threadKey === decision.threadKey);
  if (candidates.length !== 1) throw new Error("EXPERIENCE_CANDIDATE_MISMATCH");
  if (decision.evidenceAsOf.getTime() < world.asOfAt.getTime()) throw new Error("EXPERIENCE_DECISION_TIME");
  const candidate = candidates[0];
  const { candidateKey, ...candidatePayload } = candidate;
  if (canonicalProtocolHash("cmooc.autonomy-candidate.v1", candidatePayload as unknown as CanonicalJsonValue) !== candidateKey) {
    throw new Error("EXPERIENCE_CANDIDATE_HASH");
  }
  const anchor = parseCommunityInquiryMemoryProjection({
    courseAlias, invocationId: decision.invocationId, worldSnapshotId: world.id,
    graphSnapshotId: graph.id, candidateSetId: candidateRow.id, asOfAt: world.asOfAt.toISOString(),
    worldHash: world.worldHash, graphHash: graph.contentGraphHash, candidateSetHash: candidateRow.candidateSetHash
  });
  const normalized = decision.decision.toUpperCase();
  const legacy = normalized === "INTERVENE" ? "DRAFT" : normalized;
  if (!["DRAFT", "WAIT", "ABSTAIN", "YIELD"].includes(legacy)) throw new Error("EXPERIENCE_DECISION_INVALID");
  const baseline: CommunityInquiryShadowDecision = {
    decision: legacy as CommunityInquiryShadowDecision["decision"], targetKey: candidateKey,
    facilitationFunction: null, responsibility: null, reasonCode: decision.reasonCode
  };
  return { anchor, candidate, baseline, decision };
}

export async function listExperienceDecisionContexts(prisma: PrismaClient | Prisma.TransactionClient, courseAlias: string) {
  const decisions = await prisma.autonomyDecision.findMany({
    where: { courseAlias }, orderBy: [{ evidenceAsOf: "desc" }, { decisionKey: "asc" }], take: 20
  });
  const loaded = await Promise.all(decisions.map(async row => {
    try {
      const context = await loadExperienceDecisionContext(prisma, courseAlias, row.decisionKey);
      return { decisionKey: row.decisionKey, candidateKey: context.candidate.candidateKey,
        asOfAt: context.anchor.asOfAt, decision: context.baseline.decision };
    } catch { return null; }
  }));
  return loaded.filter((value): value is NonNullable<typeof value> => value !== null);
}
