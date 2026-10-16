import type { OperatorOpportunityState } from "@/lib/workbench/operator-read-model";

export const AGENT_NATIVE_WORKBENCH_SCHEMA_VERSION =
  "cmooc.agent-native-workbench.v1" as const;

export type AgentNativeWriteMode =
  | "READ_ONLY"
  | "OBSERVE"
  | "SHADOW"
  | "STAGE"
  | "AUTO"
  | "HALTED";

export type AgentNativeCoverage = "complete" | "partial" | "unavailable";
export type AgentNativeFreshness = "as_of_snapshot" | "unavailable";
export type AgentNativeSystemState =
  | "READY"
  | "ERROR"
  | "MISSING_DATA"
  | "UNAVAILABLE";
export type AgentNativeDisposition = "DRAFT" | "WAIT" | "ABSTAIN" | "YIELD";
export type AgentNativeActionType =
  | "START"
  | "REPLY"
  | "INSPECT"
  | "VERIFY"
  | "NONE";

export type ScopeContext = Readonly<{
  courseId: string | null;
  courseAlias: string | null;
  courseName: string | null;
  snapshotId: string | null;
  invocationId: string | null;
  timeBoundary: string | null;
  policyVersion: string | null;
  modelVersion: string | null;
  writeMode: AgentNativeWriteMode;
  externalWrites: 0;
  coverage: AgentNativeCoverage;
  freshness: AgentNativeFreshness;
}>;

export type FocusObjectType =
  | "attention_item"
  | "opportunity"
  | "world_entity"
  | "run"
  | "run_step"
  | "evidence_bundle"
  | "outcome_comparison"
  | "governance_rule"
  | "agent_lease";

export type FocusObject = Readonly<{
  type: FocusObjectType;
  id: string;
  sourceRoute: string;
  summary: string;
  status: AgentNativeSystemState | AgentNativeDisposition;
}>;

export type EvidenceUnit = Readonly<{
  evidenceId: string;
  claim: string;
  sourceType: string;
  sourceRef: string;
  sourceLocation: string | null;
  timeBoundary: string | null;
  observedFact: string[];
  interpretation: string | null;
  confidence: "high" | "medium" | "low" | "unknown";
  limitations: string[];
  relatedObjectRefs: string[];
}>;

export type DecisionOption = Readonly<{
  action: AgentNativeActionType;
  target: string | null;
  supportingEvidenceRefs: string[];
  expectedEffect: string | null;
  risk: string | null;
  uncertainty: string | null;
  estimatedCost: string | null;
  reversibility: "reversible" | "not_reversible" | "unknown";
  policyResult: "allowed" | "blocked" | "unknown";
}>;

export type DecisionBrief = Readonly<{
  decisionId: string;
  question: string;
  currentObservation: string;
  whyNow: string;
  evidence: EvidenceUnit[];
  options: DecisionOption[];
  recommendation: string | null;
  humanJudgmentRequired: boolean;
  disposition: AgentNativeDisposition | null;
  systemState: AgentNativeSystemState;
}>;

export type ActionPreview = Readonly<{
  actionType: AgentNativeActionType;
  target: string | null;
  intent: string;
  evidenceRefs: string[];
  scope: ScopeContext;
  policyVersion: string | null;
  writeMode: AgentNativeWriteMode;
  externalWrites: 0;
  allowed: boolean;
  blockedReason: string | null;
  expectedEffect: string | null;
  uncertainty: string | null;
  estimatedTokens: number | null;
  estimatedToolCalls: number | null;
  estimatedDuration: string | null;
  reversible: "yes" | "no" | "unknown";
  stopCondition: string | null;
  executor: Readonly<{
    label: string;
    leaseStatus: "active" | "unavailable";
  }>;
}>;

export type AttentionItem = Readonly<{
  id: string;
  title: string;
  summary: string;
  whyNow: string;
  priority: "high" | "medium" | "low";
  kind: string;
  stateLabel: string;
  disposition: AgentNativeDisposition | null;
  systemState: AgentNativeSystemState;
  focus: FocusObject;
  evidenceRefs: string[];
  evidenceAsOf: string;
  evidenceCode: string;
  contextRef: string;
  sourceHref: string;
  canHandoff: boolean;
}>;

export type OperatorContextCapsule = Readonly<{
  schemaVersion: typeof AGENT_NATIVE_WORKBENCH_SCHEMA_VERSION;
  capsuleId: string;
  generatedAt: string;
  scope: ScopeContext;
  objective: string;
  focus: FocusObject | null;
  recentDeltas: string[];
  attention: Array<Pick<AttentionItem, "id" | "title" | "summary" | "priority" | "stateLabel">>;
  activeConstraints: string[];
  allowedActions: string[];
  blockedActions: string[];
  evidenceRefs: string[];
  unresolvedQuestions: string[];
  resourceBudget: Readonly<{
    maxTokens: number | null;
    maxToolCalls: number | null;
    deadlineOrLease: string | null;
  }>;
  nextBestActions: string[];
  deepLinks: string[];
  containsForumText: false;
  containsIdentity: false;
  externalWrites: 0;
}>;

export type AgentNativeWorkbenchViewModel = Readonly<{
  schemaVersion: typeof AGENT_NATIVE_WORKBENCH_SCHEMA_VERSION;
  scope: ScopeContext;
  focus: FocusObject | null;
  attention: AttentionItem[];
  decisionBrief: DecisionBrief | null;
  actionPreview: ActionPreview | null;
  capsule: OperatorContextCapsule;
}>;

const SAFE_FOCUS_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;

export function isSafeAgentNativeFocusId(value: string): boolean {
  return SAFE_FOCUS_ID.test(value);
}

/**
 * The Workbench owns the `brief:` focus namespace. URLSearchParams performs
 * the actual query escaping; keeping this value logical also makes copied
 * links readable after a browser round-trip.
 */
export function serializeBriefFocus(id: string): string | null {
  const value = id.trim();
  return isSafeAgentNativeFocusId(value) ? `brief:${value}` : null;
}

export function parseBriefFocus(value: string | null | undefined): string | null {
  if (!value || !value.startsWith("brief:")) return null;
  const encodedId = value.slice("brief:".length);
  if (!encodedId) return null;
  let id = encodedId;
  try {
    id = decodeURIComponent(encodedId);
  } catch {
    return null;
  }
  return isSafeAgentNativeFocusId(id) ? id : null;
}

export function buildWorkbenchFocusHref(input: {
  pathname?: string;
  searchParams: URLSearchParams;
  focusId?: string | null;
}): string {
  const params = new URLSearchParams(input.searchParams.toString());
  const focus = input.focusId ? serializeBriefFocus(input.focusId) : null;
  if (focus) params.set("focus", focus);
  else params.delete("focus");
  const query = params.toString();
  return `${input.pathname ?? "/workbench"}${query ? `?${query}` : ""}`;
}

export function dispositionForOperatorState(
  state: OperatorOpportunityState | null
): AgentNativeDisposition | null {
  if (state === "draft") return "DRAFT";
  if (state === "wait") return "WAIT";
  if (state === "abstain") return "ABSTAIN";
  if (state === "yield") return "YIELD";
  return null;
}
