import type { BrowserParticipationChoice } from "./browser-course-contracts";

const precedence: Record<BrowserParticipationChoice["choice"], number> = {
  stop: 5, decline: 4, request_teacher: 3, wait_for_peers: 2, resume: 0
};

/** Event time wins over arrival order. Unordered ties retain the restrictive
 * choice unless a teacher explicitly corrects a record in that same bucket. */
export function effectiveParticipationChoice(choices: readonly BrowserParticipationChoice[], discussionRef: string, actorAlias: string, asOf: string) {
  const eligible = choices.filter((choice) => choice.discussionRef === discussionRef && choice.actorAlias === actorAlias &&
    Date.parse(choice.observedAt) <= Date.parse(asOf));
  if (!eligible.length) return undefined;
  const latestTime = Math.max(...eligible.map((choice) => Date.parse(choice.observedAt)));
  const bucket = eligible.filter((choice) => Date.parse(choice.observedAt) === latestTime);
  const superseded = new Set(bucket.filter((choice) => choice.source === "teacher_review" && choice.supersedesChoiceId)
    .map((choice) => choice.supersedesChoiceId));
  return bucket.filter((choice) => !superseded.has(choice.id)).sort((a, b) =>
    precedence[b.choice] - precedence[a.choice] || Number(b.source === "teacher_review") - Number(a.source === "teacher_review") || a.id.localeCompare(b.id))[0];
}
