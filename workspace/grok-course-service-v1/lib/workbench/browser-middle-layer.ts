import type { PrismaClient } from "@prisma/client";
import { getBrowserWorkspace, sealBrowserMiddleLayerInput } from "./browser-course-store";
import { projectBrowserObservation } from "./browser-observation-projection";
import { loadExperienceDecisionContext } from "@/lib/community-memory/experience-context";
import { buildPersistedExperienceFact } from "@/lib/community-memory/experience-facts";
import { applyExperienceForDecision, recordExperienceFactsForDecision } from "@/lib/community-memory/experience-service";

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
    const posts = run.observation.posts.filter(p => p.discussionRef === discussion.ref);
    const root = posts.find(p => p.parentRef === null);
    const peer = root && posts.some(p => p.parentRef !== null && p.actorAlias !== root.actorAlias && ["learner", "teacher"].includes(p.role))
      ? "true" : discussion.complete && root && posts.every(p => p.createdAt !== null && p.role !== "unknown") ? "false" : "unknown";
    const common = { courseAlias: projection.courseAlias, decisionKey: mapping.decisionKey, anchor: context.anchor,
      observationHash: context.candidate.sourceObservationReceiptHash, observedAt: context.anchor.asOfAt,
      evidenceRefs: [{kind: "browser_observation",id: context.candidate.threadKey,
        hash: context.candidate.sourceObservationReceiptHash,observedAt: context.anchor.asOfAt}] };
    const records = [buildPersistedExperienceFact({...common, key: "peer_continuation", value: peer,
      source: "runtime_observation", interpretedAt: context.anchor.asOfAt})];
    if (discussion.interpretation) {
      const interpreted = discussion.interpretation;
      for (const key of ["activity_phase", "purpose_compatible", "teacher_required"] as const) {
        records.push(buildPersistedExperienceFact({...common,key,value: interpreted[key],
          source: "browser_interpretation", interpretedAt: interpreted.interpretedAt}));
      }
    }
    await recordExperienceFactsForDecision({prisma,courseAlias: projection.courseAlias,
      decisionKey: mapping.decisionKey,records,operationKey: `browser-facts:${context.candidate.candidateKey}`});
    const applications = await applyExperienceForDecision({prisma,courseAlias: projection.courseAlias,decisionKey: mapping.decisionKey});
    const evaluationRow = await prisma.decisionTapeEntry.findFirst({where:{invocationId:projection.invocationId,
      kind:"community_experience_evaluation",payloadJson:{contains:mapping.decisionKey}},orderBy:{sequence:"desc"}});
    const evaluation = evaluationRow ? JSON.parse(evaluationRow.payloadJson) : null;
    results.push({discussionRef: discussion.ref, decisionKey: mapping.decisionKey, baseline: context.baseline.decision,
      interpretationSource: discussion.interpretation ? "browser_interpretation" : "not_provided",
      peerContinuation: peer, evaluation: evaluation ? {outcome:evaluation.outcome,factsResolution:evaluation.factsResolution,
        lessonCount:evaluation.lessonCount,facts:evaluation.facts,factsSource:evaluation.factsSource,evaluatedAt:evaluation.evaluatedAt} : null,
      applications: applications.map(a => ({disposition:a.disposition,reasonCode:a.reasonCode,
        decision:a.decision.decision,factsSource:a.factsSource,evaluationMode:a.evaluationMode}))});
  }
  return {...projection,results,autonomyTickExecuted:false,publishAllowed:false};
}
