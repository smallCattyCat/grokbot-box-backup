import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { buildExperienceObservation, buildFacilitationLesson, applyFacilitationLesson } from "./facilitation-experience";
import { recordExperienceObservation, proposeFacilitationLesson, reviewFacilitationLesson,
  listApplicableFacilitationLessons, recordLessonApplication, listCourseExperience } from "./facilitation-experience-store";
import { loadExperienceDecisionContext, listExperienceDecisionContexts } from "./experience-context";
import type { CommunityMemoryApprovalPrincipal } from "./approval-principal";
import { assertCommunityMemoryApprovalPrincipal } from "./approval-principal";
import { appendDecisionTapeEntry } from "@/lib/autonomy/decision-tape";
import { canonicalProtocolHash, type CanonicalJsonValue } from "@/lib/facilitation-protocol";
import {
  buildExperienceFactsTapePayload,
  parseExperienceFactsTapePayload,
  selectExperienceFacts,
  type ExperienceFactsSelection,
  type ExperienceFactsTapePayload,
  type PersistedExperienceFact
} from "./experience-facts";
import type { CommunityInquiryMemoryProjection } from "./inquiry-memory";

const phase = z.enum(["question_opening", "explanation_development", "peer_review", "resource_connection", "collaborative_progress", "task_reentry", "unknown"]);
const truth = z.enum(["true", "false", "unknown"]);
export const experienceFactsSchema = z.object({ activity_phase: phase, purpose_compatible: truth,
  peer_continuation: truth, teacher_required: truth }).strict();
export type ExperienceFacts = z.infer<typeof experienceFactsSchema>;
export type ExperienceFactsProvider = {
  load(input: {
    courseAlias: string;
    decisionKey: string;
    anchor: CommunityInquiryMemoryProjection;
    baseline: import("./shadow-comparison").CommunityInquiryShadowDecision;
  }): Promise<readonly PersistedExperienceFact[] | null> | readonly PersistedExperienceFact[] | null;
};
const scope = { courseId: z.string().uuid(), operationKey: z.string().uuid() };
export const experienceMutationSchema = z.discriminatedUnion("action", [
  z.object({ ...scope, action: z.literal("propose"), decisionKey: z.string().min(1).max(160),
    method: z.enum(["resource_connection", "preserve_peer_opportunity", "teacher_handoff"]),
    activityPhase: phase, reason: z.string().trim().min(1).max(320),
    lessonKey: z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/).optional(), supersedesHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
  z.object({ ...scope, action: z.literal("review"), lessonHash: z.string().regex(/^[a-f0-9]{64}$/),
    reviewAction: z.enum(["approved", "rejected", "retracted"]) }).strict(),
  z.object({ ...scope, action: z.literal("apply"), decisionKey: z.string().min(1).max(160), facts: experienceFactsSchema }).strict()
]);

export async function readExperienceWorkspace(prisma: PrismaClient, courseAlias: string) {
  const [stored, contexts] = await Promise.all([
    listCourseExperience({ prisma, courseAlias }), listExperienceDecisionContexts(prisma, courseAlias)
  ]);
  return { ...stored, contexts };
}

function completeExperienceFacts(value: Partial<Record<keyof ExperienceFacts, string>>): ExperienceFacts {
  return experienceFactsSchema.parse({
    activity_phase: value.activity_phase ?? "unknown",
    purpose_compatible: value.purpose_compatible ?? "unknown",
    peer_continuation: value.peer_continuation ?? "unknown",
    teacher_required: value.teacher_required ?? "unknown"
  });
}

function sameExperienceAnchor(
  left: CommunityInquiryMemoryProjection,
  right: CommunityInquiryMemoryProjection
): boolean {
  return left.courseAlias === right.courseAlias &&
    left.invocationId === right.invocationId &&
    left.worldSnapshotId === right.worldSnapshotId &&
    left.graphSnapshotId === right.graphSnapshotId &&
    left.candidateSetId === right.candidateSetId &&
    left.asOfAt === right.asOfAt &&
    left.worldHash === right.worldHash &&
    left.graphHash === right.graphHash &&
    left.candidateSetHash === right.candidateSetHash;
}

async function loadPersistedExperienceFactsFromTape(input: {
  prisma: PrismaClient;
  courseAlias: string;
  decisionKey: string;
  anchor: CommunityInquiryMemoryProjection;
}): Promise<readonly PersistedExperienceFact[]> {
  const rows = await input.prisma.decisionTapeEntry.findMany({
    where: {
      invocationId: input.anchor.invocationId,
      kind: "community_experience_facts_v1",
      payloadJson: { contains: input.decisionKey }
    },
    orderBy: { sequence: "desc" },
    take: 64
  });
  for (const row of rows) {
    let raw: unknown;
    try {
      raw = JSON.parse(row.payloadJson);
    } catch {
      continue;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const candidate = raw as Record<string, unknown>;
    if (candidate.courseAlias !== input.courseAlias || candidate.decisionKey !== input.decisionKey) continue;
    if (!candidate.anchor || typeof candidate.anchor !== "object" || Array.isArray(candidate.anchor)) continue;
    try {
      const anchor = candidate.anchor as CommunityInquiryMemoryProjection;
      if (!sameExperienceAnchor(anchor, input.anchor)) continue;
      return parseExperienceFactsTapePayload(raw, {
        courseAlias: input.courseAlias,
        decisionKey: input.decisionKey,
        anchor: input.anchor
      }).records;
    } catch {
      throw new Error("EXPERIENCE_FACTS_TAPE_INVALID");
    }
  }
  return [];
}

/** Server-only producer for the lease-validated Browser -> Autonomy bridge. */
export async function recordExperienceFactsForDecision(input: {
  prisma: PrismaClient;
  courseAlias: string;
  decisionKey: string;
  records: readonly PersistedExperienceFact[];
  operationKey: string;
}): Promise<ExperienceFactsTapePayload> {
  const context = await loadExperienceDecisionContext(
    input.prisma,
    input.courseAlias,
    input.decisionKey
  );
  const payload = buildExperienceFactsTapePayload({
    courseAlias: input.courseAlias,
    decisionKey: input.decisionKey,
    anchor: context.anchor,
    records: input.records,
    operationKey: input.operationKey
  });
  const existingRows = await input.prisma.decisionTapeEntry.findMany({
    where: {
      invocationId: context.anchor.invocationId,
      kind: "community_experience_facts_v1",
      payloadJson: { contains: input.operationKey }
    },
    orderBy: { sequence: "desc" },
    take: 16
  });
  for (const row of existingRows) {
    try {
      const existing = parseExperienceFactsTapePayload(JSON.parse(row.payloadJson));
      if (existing.operationKey === input.operationKey && existing.payloadHash !== payload.payloadHash) {
        throw new Error("EXPERIENCE_IDEMPOTENCY_CONFLICT");
      }
    } catch (error) {
      if (error instanceof Error && error.message === "EXPERIENCE_IDEMPOTENCY_CONFLICT") throw error;
      throw new Error("EXPERIENCE_FACTS_TAPE_INVALID");
    }
  }
  const saved = await uniqueExperienceTape(
    input.prisma,
    context.anchor.invocationId,
    "community_experience_facts_v1",
    input.operationKey,
    payload as unknown as Record<string, CanonicalJsonValue>
  );
  return parseExperienceFactsTapePayload(saved, {
    courseAlias: input.courseAlias,
    decisionKey: input.decisionKey,
    anchor: context.anchor
  });
}

/** Both native ticks and explicit local-host comparisons use the same application path. */
export async function applyExperienceForDecision(input: { prisma: PrismaClient; courseAlias: string;
  decisionKey: string; facts?: ExperienceFacts; principal?: CommunityMemoryApprovalPrincipal; operationKey?: string;
  factsProvider?: ExperienceFactsProvider }) {
  const { prisma, courseAlias, decisionKey } = input;
  const context = await loadExperienceDecisionContext(prisma, courseAlias, decisionKey);
  if (input.facts) assertCommunityMemoryApprovalPrincipal(input.principal, { courseAlias });
  let facts: ExperienceFacts;
  let factsSource: "host_judgement" | "runtime_observation" | "browser_interpretation";
  let evaluatedAt: string;
  let factsResolution: string;
  let factsSelectionHash: string | null = null;
  let selectedFactEvidence: ExperienceFactsSelection["selected"] = [];
  if (input.facts) {
    facts = input.facts;
    factsSource = "host_judgement";
    evaluatedAt = input.principal!.issuedAt;
    factsResolution = "host_review";
  } else {
    const records = input.factsProvider
      ? await input.factsProvider.load({
          courseAlias,
          decisionKey,
          anchor: context.anchor,
          baseline: context.baseline
        })
      : await loadPersistedExperienceFactsFromTape({
          prisma,
          courseAlias,
          decisionKey,
          anchor: context.anchor
        });
    const selection = selectExperienceFacts({
      records,
      courseAlias,
      decisionKey,
      anchor: context.anchor
    });
    facts = completeExperienceFacts(selection.facts as Partial<Record<keyof ExperienceFacts, string>>);
    factsSource = selection.factsSource;
    evaluatedAt = selection.evaluatedAt;
    factsResolution = selection.resolution;
    factsSelectionHash = selection.selectionHash;
    selectedFactEvidence = selection.selected;
  }
  const evaluationInputHash = canonicalProtocolHash("cmooc.experience-evaluation-input.v1", {
    decisionKey,
    facts,
    factsSource,
    factsResolution,
    factsSelectionHash,
    reviewerRefHash: input.principal?.reviewerRefHash ?? null
  });
  const prepared = input.facts ? await uniqueExperienceTape(prisma, context.anchor.invocationId,
    "community_experience_prepared", input.operationKey ?? evaluationInputHash, {
      inputHash: evaluationInputHash, evaluatedAt: input.principal!.issuedAt,
      reviewerRefHash: input.principal!.reviewerRefHash, facts, containsForumText: false
    }) : null;
  if (prepared && prepared.inputHash !== evaluationInputHash) throw new Error("EXPERIENCE_IDEMPOTENCY_CONFLICT");
  if (prepared) evaluatedAt = String(prepared.evaluatedAt);
  const lessons = await listApplicableFacilitationLessons({ prisma, courseAlias, asOfAt: context.anchor.asOfAt });
  const results = [];
  for (const { lesson, acceptedAt } of lessons) {
    const application = applyFacilitationLesson({ lesson, targetAnchor: context.anchor,
      candidateKey: context.candidate.candidateKey, baseline: context.baseline,
      evaluatedAt, facts: { ...facts, factsSource }, acceptedAt });
    await recordLessonApplication({ prisma, application, principal: input.principal, operationKey: `application:${application.applicationHash}` });
    results.push(application);
  }
  // Record the provenance of the current facts independently of the lesson.
  // A local owner assessment is never relabelled as a platform observation.
  const payload = {
    schemaVersion: "cmooc.community-experience-evaluation.v1", decisionKey,
    candidateKey: context.candidate.candidateKey, anchor: context.anchor,
    facts, evaluatedAt, factsSource, factsResolution, factsSelectionHash,
    selectedFactEvidence,
    lessonCount: lessons.length,
    outcome: results.length === 0
      ? "no_accepted_experience"
      : results.some((value) => value.disposition === "adopted")
        ? "applied"
        : results.some((value) => value.disposition === "needs_check")
          ? "conditions_unresolved"
          : "conditions_rejected",
    reviewerRefHash: input.principal?.reviewerRefHash ?? null,
    applicationHashes: results.map(value => value.applicationHash),
    publishAllowed: false, editorWriteAllowed: false, containsForumText: false
  };
  const evaluationHash = canonicalProtocolHash(payload.schemaVersion, payload as unknown as CanonicalJsonValue);
  await uniqueExperienceTape(prisma, context.anchor.invocationId, "community_experience_evaluation",
    evaluationHash, { ...payload, evaluationHash } as unknown as Record<string, CanonicalJsonValue>);
  return results;
}

export async function mutateExperienceWorkspace(input: { prisma: PrismaClient; courseAlias: string;
  principal: CommunityMemoryApprovalPrincipal; body: z.infer<typeof experienceMutationSchema> }) {
  const { prisma, courseAlias, principal, body } = input;
  assertCommunityMemoryApprovalPrincipal(principal, { courseAlias });
  if (body.action === "review") {
    await reviewFacilitationLesson({ prisma, lessonHash: body.lessonHash, action: body.reviewAction,
      principal, operationKey: body.operationKey });
  } else if (body.action === "apply") {
    await applyExperienceForDecision({ prisma, courseAlias, decisionKey: body.decisionKey, facts: body.facts, principal, operationKey: body.operationKey });
  } else {
    const context = await loadExperienceDecisionContext(prisma, courseAlias, body.decisionKey);
    const sourceReceipts = await prisma.autonomyObservation.findMany({
      where: { invocationId: context.anchor.invocationId, threadKey: context.decision.threadKey, observedAt: { lte: new Date(context.anchor.asOfAt) } },
      orderBy: [{ observedAt: "asc" }, { receiptHash: "asc" }],
      select: { receiptHash: true }, take: 10
    });
    const current = await listCourseExperience({ prisma, courseAlias });
    const priorObservation = current.observations.find(value => value.observationKey === `correction:${body.operationKey}`);
    const recordedAt = priorObservation?.recordedAt ?? principal.issuedAt;
    const observation = buildExperienceObservation({
      observationKey: `correction:${body.operationKey}`, sourceAnchor: context.anchor,
      candidateKey: context.candidate.candidateKey, decisionKey: body.decisionKey,
      recordedAt, decision: context.baseline,
      feedback: { kind: "host_correction", reason: body.reason },
      evidenceLevel: "shadow", sourceObservationHashes: [...(priorObservation?.sourceObservationHashes ?? sourceReceipts.map(value => value.receiptHash))]
    });
    await recordExperienceObservation({ prisma, observation, operationKey: `observation:${body.operationKey}` });
    const previous = body.supersedesHash ? current.lessons.find(value => value.lessonHash === body.supersedesHash) : undefined;
    if (body.supersedesHash && !previous) throw new Error("EXPERIENCE_PREVIOUS_NOT_FOUND");
    const conditions: { key: "activity_phase" | "purpose_compatible" | "peer_continuation" | "teacher_required"; expected: string }[] = [];
    if (body.activityPhase !== "unknown") conditions.push({ key: "activity_phase", expected: body.activityPhase });
    if (body.method === "resource_connection") conditions.push({ key: "purpose_compatible", expected: "true" });
    if (body.method === "preserve_peer_opportunity") conditions.push({ key: "peer_continuation", expected: "false" });
    if (body.method === "teacher_handoff") conditions.push({ key: "teacher_required", expected: "true" });
    const lesson = buildFacilitationLesson({
      courseAlias, lessonKey: previous?.lessonKey ?? body.lessonKey ?? `lesson:${body.operationKey}`,
      version: previous ? previous.version + 1 : 1, sourceObservationHashes: [observation.observationHash],
      sourceAnchor: context.anchor, recordedAt, method: body.method,
      activityPhase: body.activityPhase, conditions, reason: body.reason,
      supersedesHash: body.supersedesHash ?? null
    });
    await proposeFacilitationLesson({ prisma, lesson, operationKey: body.operationKey });
  }
  return readExperienceWorkspace(prisma, courseAlias);
}

async function uniqueExperienceTape(prisma: PrismaClient, invocationId: string, kind: string,
  operationKey: string, payload: Record<string, CanonicalJsonValue>): Promise<Record<string, CanonicalJsonValue>> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(async transaction => {
        const rows = await transaction.decisionTapeEntry.findMany({ where: { invocationId, kind,
          payloadJson: { contains: operationKey } }, orderBy: { sequence: "desc" }, take: 10 });
        for (const row of rows) {
          const existing = JSON.parse(row.payloadJson) as Record<string, CanonicalJsonValue>;
          if (existing.operationKey === operationKey) return existing;
        }
        const value = { ...payload, operationKey };
        await appendDecisionTapeEntry({ prisma: transaction, invocationId, kind, payload: value });
        return value;
      });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (attempt >= 3 || !["P2002", "P2034", "P1008", "P2028"].includes(code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}
