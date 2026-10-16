import type { PrismaClient } from "@prisma/client";
import { getBrowserWorkspace, sealBrowserMiddleLayerInput } from "./browser-course-store";
import { projectBrowserObservation } from "./browser-observation-projection";
import { loadExperienceDecisionContext } from "@/lib/community-memory/experience-context";
import { buildPersistedExperienceFact, parseExperienceFactsTapePayload } from "@/lib/community-memory/experience-facts";
import { applyExperienceForDecision, recordExperienceFactsForDecision } from "@/lib/community-memory/experience-service";
import { getBrowserDiscussionIdentity, type BrowserContinuation } from "./browser-course-contracts";

const SUBSTANTIVE_CONTINUATION_KINDS = new Set<BrowserContinuation["kind"]>([
  "clarification", "explanation_advance", "correction", "resource_use", "peer_connection"
]);

function isHumanReply(post: { parentRef: string | null; actorAlias: string; role: string }): boolean {
  return post.parentRef !== null && (post.role === "learner" || post.role === "teacher") && post.actorAlias !== "AGENT";
}

function continuationFunction(kind: BrowserContinuation["kind"] | undefined): "courtesy" | "substantive" | "unknown" {
  if (!kind || kind === "unknown") return "unknown";
  return kind === "acknowledgement" ? "courtesy" : SUBSTANTIVE_CONTINUATION_KINDS.has(kind) ? "substantive" : "unknown";
}

function peerContinuationValue(input: {
  continuation?: BrowserContinuation;
  peerReplyRefs: Set<string>;
  discussionComplete: boolean;
  structurallyComplete: boolean;
}): "true" | "false" | "unknown" {
  const continuation = input.continuation;
  if (continuation) {
    if (continuation.kind === "unknown") return "unknown";
    if (!SUBSTANTIVE_CONTINUATION_KINDS.has(continuation.kind)) return "false";
    return continuation.evidenceRefs.some((ref) => input.peerReplyRefs.has(ref)) ? "true" : "false";
  }
  // A structural reply without an explicit function is deliberately unknown.
  // Only a complete observation with no human reply supports a false value.
  return input.discussionComplete && input.structurallyComplete && input.peerReplyRefs.size === 0 ? "false" : "unknown";
}

/** Called only after the authenticated Browser lease has saved server-resolved proposals.
 * Reread the private store; callers cannot supply an anchor, baseline or identity. */
export async function syncBrowserMiddleLayer(prisma: PrismaClient, runId: string) {
  const workspace = await getBrowserWorkspace();
  const run = workspace.runs.find(r => r.id === runId);
  const course = workspace.courses.find(c => c.id === run?.courseId);
  if (!run || !course || !run.observation) throw new Error("BROWSER_MIDDLE_LAYER_RUN_MISSING");
  const sealedRun = await sealBrowserMiddleLayerInput(runId);
  if (sealedRun.observation !== null && JSON.stringify(sealedRun.observation) !== JSON.stringify(run.observation)) throw new Error("BROWSER_MIDDLE_LAYER_OBSERVATION_CHANGED");
  const projection = await projectBrowserObservation({ prisma, course, run: sealedRun });
  const results = [];
  for (const mapping of projection.decisionMappings) {
    const context = await loadExperienceDecisionContext(prisma, projection.courseAlias, mapping.decisionKey);
    const discussion = run.observation.discussions.find(d => d.ref === mapping.discussionRef)!;
    const discussionIdentity = getBrowserDiscussionIdentity(run.observation, discussion);
    const posts = run.observation.posts.filter(p => p.discussionRef === discussion.ref);
    const root = posts.find(p => p.parentRef === null);
    const humanReplies = posts.filter(isHumanReply);
    const peerReplies = root ? humanReplies.filter((post) => post.actorAlias !== root.actorAlias) : [];
    const authorReturns = root ? humanReplies.filter((post) => post.actorAlias === root.actorAlias) : [];
    const structurallyComplete = !!root && posts.every((post) => post.createdAt !== null && post.role !== "unknown");
    const structuralResponse: "present" | "absent" | "unknown" = humanReplies.length > 0
      ? "present" : discussion.complete && structurallyComplete ? "absent" : "unknown";
    const peer = peerContinuationValue({ continuation: discussion.continuation, peerReplyRefs: new Set(peerReplies.map((post) => post.ref)),
      discussionComplete: discussion.complete, structurallyComplete });
    const functionKind = continuationFunction(discussion.continuation?.kind);
    const followup = discussion.continuation?.followup ?? "unknown";
    const common = { courseAlias: projection.courseAlias, decisionKey: mapping.decisionKey, anchor: context.anchor,
      observationHash: context.candidate.sourceObservationReceiptHash, observedAt: context.anchor.asOfAt,
      evidenceRefs: [{kind: "browser_observation",id: context.candidate.threadKey,
        hash: context.candidate.sourceObservationReceiptHash,observedAt: context.anchor.asOfAt}] };
    // R2 facts use a versioned operation key so a legacy R5 structural=true
    // record is never mutated in place. A plain runtime observation cannot
    // establish the function of a reply, so it records unknown explicitly;
    // only the browser interpretation may promote a peer continuation.
    const records = [buildPersistedExperienceFact({...common, key: "peer_continuation", value: peer,
      source: discussion.continuation ? "browser_interpretation" : "runtime_observation",
      interpretedAt: discussion.continuation?.interpretedAt ?? context.anchor.asOfAt})];
    if (discussion.interpretation) {
      const interpreted = discussion.interpretation;
      for (const key of ["activity_phase", "purpose_compatible", "teacher_required"] as const) {
        records.push(buildPersistedExperienceFact({...common,key,value: interpreted[key],
          source: "browser_interpretation", interpretedAt: interpreted.interpretedAt}));
      }
    }
    if (records.length > 0) {
      await recordExperienceFactsForDecision({prisma,courseAlias: projection.courseAlias,
        decisionKey: mapping.decisionKey,records,operationKey: `browser-facts:r2:${context.candidate.candidateKey}`});
    }
    const applications = await applyExperienceForDecision({
      prisma, courseAlias: projection.courseAlias, decisionKey: mapping.decisionKey,
      // R5 stored a structural reply as runtime peer_continuation=true. Keep
      // that immutable evidence visible for audit, but do not let it feed an
      // R2 semantic evaluation. New true values are browser_interpretation
      // records tied to explicit continuation evidence.
      factsProvider: {
        load: async ({ anchor, courseAlias, decisionKey }) => {
          const rows = await prisma.decisionTapeEntry.findMany({
            where: { invocationId: anchor.invocationId, kind: "community_experience_facts_v1", payloadJson: { contains: decisionKey } },
            orderBy: { sequence: "asc" }, take: 64
          });
          const facts = [] as ReturnType<typeof buildPersistedExperienceFact>[];
          for (const row of rows) {
            try {
              const payload = parseExperienceFactsTapePayload(JSON.parse(row.payloadJson), { courseAlias, decisionKey, anchor });
              facts.push(...payload.records);
            } catch {
              // The default provider treats an invalid tape as a hard error.
              // Here we preserve that boundary instead of guessing a fact.
              throw new Error("EXPERIENCE_FACTS_TAPE_INVALID");
            }
          }
          return facts.filter((fact) => !(fact.key === "peer_continuation" && fact.source === "runtime_observation" && fact.value === "true"));
        }
      }
    });
    const evaluationRow = await prisma.decisionTapeEntry.findFirst({where:{invocationId:projection.invocationId,
      kind:"community_experience_evaluation",payloadJson:{contains:mapping.decisionKey}},orderBy:{sequence:"desc"}});
    const evaluation = evaluationRow ? JSON.parse(evaluationRow.payloadJson) : null;
    results.push({discussionRef: discussion.ref, identityKey: discussionIdentity.key, identityBasis: discussionIdentity.basis,
      longitudinalMerge: discussionIdentity.longitudinalMerge, decisionKey: mapping.decisionKey, baseline: context.baseline.decision,
      interpretationSource: discussion.continuation || discussion.interpretation ? "browser_interpretation" : "not_provided",
      structuralResponse, peerReplyCount: peerReplies.length, authorReturnCount: authorReturns.length,
      continuationFunction: functionKind, continuationKind: discussion.continuation?.kind ?? null,
      followup, legacyStructuralOnly: !discussion.continuation && peerReplies.length > 0,
      peerContinuation: peer, evaluation: evaluation ? {outcome:evaluation.outcome,factsResolution:evaluation.factsResolution,
        lessonCount:evaluation.lessonCount,facts:evaluation.facts,factsSource:evaluation.factsSource,evaluatedAt:evaluation.evaluatedAt} : null,
      applications: applications.map(a => ({disposition:a.disposition,reasonCode:a.reasonCode,
        decision:a.decision.decision,factsSource:a.factsSource,evaluationMode:a.evaluationMode}))});
  }
  return {...projection,results,autonomyTickExecuted:false,publishAllowed:false};
}
