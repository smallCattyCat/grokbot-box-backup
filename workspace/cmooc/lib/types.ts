export type InterventionType =
  | "resource_connector"
  | "cognitive_conflict"
  | "emotional_support"
  | "mixed";

export type PublishTarget = "post_comment" | "comment_reply";

export type CanonicalTaskStatus =
  | "proposed"
  | "review_required"
  | "ready"
  | "publishing"
  | "published"
  | "failed_retryable"
  | "reconcile_required"
  | "skipped";

export type LegacyTaskStatus =
  | "discovered"
  | "analyzed"
  | "candidate"
  | "drafted"
  | "safety_checked"
  | "queued"
  | "failed"
  | "manual_review";

// Legacy values remain readable during migration, but every write path
// normalizes them into CanonicalTaskStatus.
export type TaskStatus = CanonicalTaskStatus | LegacyTaskStatus;

export type AgentStatus = "success" | "failed";

export type CieClassification = {
  cieLevel: number;
  cieLabel: string;
  reason: string;
};

export type InteractionSignal = {
  emotionLabel: string;
  topicRelevance: number;
  cognitiveDepth: number;
  discussionPotential: number;
  unansweredHours: number;
  isolatedLearnerScore: number;
  duplicateScore: number;
  lowLevelDense: boolean;
  resourceNeed: boolean;
};

export type SchedulerDecision = {
  interventionType: InterventionType;
  publishTarget: PublishTarget;
  targetCommentStrategy?: "first" | "last" | "by_text";
  targetCommentIndex?: number;
  reason: string;
};

export type MentalState = {
  empathy: number;
  curiosity: number;
  challengeLevel: number;
  warmth: number;
  focus: string;
};

export type SafetyResult = {
  safetyRisk: number;
  safetyResult: string;
  route: "ready" | "review_required";
  issues: string[];
};
