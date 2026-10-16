import type { AgentContextSnapshot } from "@prisma/client";
import { prisma } from "@/lib/db";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function parseRecord(value: string): JsonRecord {
  try {
    return record(JSON.parse(value));
  } catch {
    return {};
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").slice(0, 20)
    : [];
}

function regulation(value: unknown) {
  const source = record(value);
  return {
    empathy: number(source.empathy),
    curiosity: number(source.curiosity),
    challengeLevel: number(source.challengeLevel),
    warmth: number(source.warmth),
    focus: text(source.focus)
  };
}

export type AgentContextTrace = ReturnType<typeof serializeAgentContextSnapshot>;

export function serializeAgentContextSnapshot(snapshot: AgentContextSnapshot) {
  const observation = parseRecord(snapshot.observationJson);
  const boundary = record(observation.evidenceBoundary);
  const post = record(observation.postObservation);
  const learner = record(observation.learnerCourseObservation);
  const inference = parseRecord(snapshot.inferenceJson);
  const postSignals = record(inference.postSignalHypotheses);
  const courseSignals = record(inference.courseAggregateHypotheses);
  const expression = parseRecord(snapshot.expressionJson);
  const companion = record(expression.companion);

  return {
    id: snapshot.id,
    revision: snapshot.revision,
    asOfAt: snapshot.asOfAt.toISOString(),
    createdAt: snapshot.createdAt.toISOString(),
    futureInformationUsed: snapshot.futureInformationUsed,
    versions: {
      observation: snapshot.observationSchemaVersion,
      inference: snapshot.inferenceModelVersion,
      expression: snapshot.expressionPolicyVersion
    },
    observation: {
      source: text(boundary.postObservationSource),
      sourceRunId: text(boundary.postSnapshotRunId) ?? text(boundary.learnerProfileSourceRunId),
      rawPostContentCopied: boolean(boundary.rawPostContentCopied),
      observedAt: text(post.observedAt),
      post: {
        sourceKind: text(post.sourceKind),
        createdAt: text(post.createdAt),
        lastReplyAt: text(post.lastReplyAt),
        replyCount: number(post.replyCount),
        likeCount: number(post.likeCount),
        viewCount: number(post.viewCount)
      },
      learnerCourse: Object.keys(learner).length > 0
        ? {
          generatedAt: text(learner.generatedAt),
          evidenceAsOfAt: text(learner.evidenceAsOfAt),
          utteranceCount: number(learner.utteranceCount),
          postCount: number(learner.postCount),
          replyCount: number(learner.replyCount),
          incomingInteractionCount: number(learner.incomingInteractionCount),
          outgoingInteractionCount: number(learner.outgoingInteractionCount)
        }
        : null
    },
    inference: {
      nonDiagnostic: boolean(inference.nonDiagnostic),
      stablePersonalityClaimed: boolean(inference.stablePersonalityClaimed),
      postSignals: Object.keys(postSignals).length > 0
        ? {
          cieLevel: number(postSignals.cieLevel),
          cieLabel: text(postSignals.cieLabel),
          emotionLabel: text(postSignals.emotionLabel),
          cognitiveDepth: number(postSignals.cognitiveDepth),
          discussionPotential: number(postSignals.discussionPotential),
          unansweredHours: number(postSignals.unansweredHours),
          isolatedLearnerScore: number(postSignals.isolatedLearnerScore),
          analyzedAt: text(postSignals.analyzedAt)
        }
        : null,
      courseSignals: Object.keys(courseSignals).length > 0
        ? {
          dominantEmotion: text(courseSignals.dominantEmotion),
          avgConfusionScore: number(courseSignals.avgConfusionScore),
          avgUrgencyScore: number(courseSignals.avgUrgencyScore),
          questionRatio: number(courseSignals.questionRatio),
          riskFlags: stringList(courseSignals.riskFlags)
        }
        : null,
      regulation: regulation(inference.agentRegulationState)
    },
    expression: {
      interventionType: text(expression.interventionType),
      companion: {
        name: text(companion.name),
        persona: text(companion.persona),
        tone: text(companion.tone),
        roleBoundary: text(companion.roleBoundary)
      },
      regulation: regulation(expression.taskLocalRegulation),
      persistentAgentPersonalityMutated: boolean(expression.persistentAgentPersonalityMutated),
      learnerIdentitySimulated: boolean(expression.learnerIdentitySimulated)
    }
  };
}

export async function getAgentContextTraces(taskId: string, take = 20) {
  const task = await prisma.interventionTask.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      contextSnapshots: {
        orderBy: { revision: "desc" },
        take: Math.min(Math.max(take, 1), 100)
      }
    }
  });
  if (!task) return null;
  return {
    taskId: task.id,
    snapshots: task.contextSnapshots.map(serializeAgentContextSnapshot)
  };
}
