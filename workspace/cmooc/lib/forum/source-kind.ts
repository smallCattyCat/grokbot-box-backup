export const FORUM_SOURCE_KINDS = ["learner", "companion", "system", "test", "unknown"] as const;

export type ForumSourceKind = typeof FORUM_SOURCE_KINDS[number];

type SourceKindInput = {
  storedSourceKind?: string | null;
  authorRole?: string | null;
  authorForumUserId?: string | null;
  authorTagsJson?: string | null;
  postUrl?: string | null;
  isCompanionReply?: boolean;
  companionType?: string | null;
};

function normalized(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

export function normalizeForumSourceKind(value: string | null | undefined): ForumSourceKind {
  const normalizedValue = normalized(value);
  return FORUM_SOURCE_KINDS.includes(normalizedValue as ForumSourceKind)
    ? normalizedValue as ForumSourceKind
    : "unknown";
}

export function inferForumSourceKind(input: SourceKindInput): ForumSourceKind {
  const stored = normalizeForumSourceKind(input.storedSourceKind);
  const role = normalized(input.authorRole);
  const forumUserId = normalized(input.authorForumUserId);
  const tags = normalized(input.authorTagsJson);
  const postUrl = normalized(input.postUrl);

  if (
    input.isCompanionReply
    || Boolean(input.companionType)
    || stored === "companion"
    || /companion|assistant|学伴/.test(role)
  ) return "companion";

  if (
    stored === "system"
    || /scanner|system/.test(role)
    || forumUserId === "real-forum-scanner"
  ) return "system";

  if (
    stored === "test"
    || role === "test"
    || postUrl.startsWith("/mock-forum")
    || tags.includes("\"fixture\"")
    || tags.includes("\"test\"")
  ) return "test";

  if (stored === "learner" || role === "learner") return "learner";
  return "unknown";
}

export function isLearnerProfileSource(sourceKind: ForumSourceKind) {
  return sourceKind === "learner";
}
