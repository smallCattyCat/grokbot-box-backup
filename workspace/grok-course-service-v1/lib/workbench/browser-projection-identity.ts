import { canonicalProtocolHash, type CanonicalJsonValue } from "@/lib/facilitation-protocol";
import type { BrowserObservation, BrowserProposalInput } from "./browser-course-contracts";

export function browserProjectionDecisionPayload(proposals: readonly BrowserProposalInput[]) {
  return proposals.map(p => ({discussionRef:p.discussionRef,decision:p.decision,intent:p.intent ?? null}))
    .sort((a,b) => a.discussionRef.localeCompare(b.discussionRef));
}
export function browserProjectionSeal(observation: BrowserObservation, proposals: readonly BrowserProposalInput[]) {
  return {
    observationHash: canonicalProtocolHash("browser.projection-observation.v1", observation as unknown as CanonicalJsonValue),
    decisionHash: canonicalProtocolHash("browser.projection-decisions.v1", browserProjectionDecisionPayload(proposals) as unknown as CanonicalJsonValue)
  };
}
