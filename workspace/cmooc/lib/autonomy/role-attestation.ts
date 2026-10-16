import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import {
  constantTimeEqualHex,
  localEvidenceHmac
} from "@/lib/privacy/local-evidence-hmac";

export const COURSE_ROLE_ATTESTATION_SCHEMA_VERSION =
  "cmooc.bound-course-role-attestation.v2" as const;

export type AttestedCourseRole =
  | "learner"
  | "creator"
  | "helper";

export type BoundCourseRoleEvidenceInput = {
  courseKey: string;
  threadKey: string;
  authorKey: string;
  role: AttestedCourseRole;
  evidenceAsOf: string;
  expiresAt: string;
  targetVersionHash: string;
};

function normalizedMaterial(
  input: BoundCourseRoleEvidenceInput
): CanonicalJsonValue {
  for (const [label, value] of [
    ["courseKey", input.courseKey],
    ["threadKey", input.threadKey],
    ["authorKey", input.authorKey],
    ["targetVersionHash", input.targetVersionHash]
  ] as const) {
    if (!/^[a-f0-9]{64}$/i.test(value)) {
      throw new Error(`COURSE_ROLE_${label.toUpperCase()}_INVALID`);
    }
  }
  if (!["learner", "creator", "helper"].includes(input.role)) {
    throw new Error("COURSE_ROLE_VALUE_INVALID");
  }
  const evidenceAsOf = new Date(input.evidenceAsOf);
  const expiresAt = new Date(input.expiresAt);
  if (
    !Number.isFinite(evidenceAsOf.getTime()) ||
    !Number.isFinite(expiresAt.getTime()) ||
    evidenceAsOf.getTime() >= expiresAt.getTime()
  ) {
    throw new Error("COURSE_ROLE_TIME_INVALID");
  }
  return {
    schemaVersion: COURSE_ROLE_ATTESTATION_SCHEMA_VERSION,
    courseKey: input.courseKey.toLowerCase(),
    threadKey: input.threadKey.toLowerCase(),
    authorKey: input.authorKey.toLowerCase(),
    role: input.role,
    evidenceAsOf: evidenceAsOf.toISOString(),
    expiresAt: expiresAt.toISOString(),
    targetVersionHash: input.targetVersionHash.toLowerCase(),
    containsForumText: false
  };
}

export function computeCourseRoleEvidenceMac(
  input: BoundCourseRoleEvidenceInput & {
    secret: Buffer | string;
  }
): string {
  const materialHash = canonicalProtocolHash(
    COURSE_ROLE_ATTESTATION_SCHEMA_VERSION,
    normalizedMaterial(input)
  );
  return localEvidenceHmac({
    secret: input.secret,
    scope: "autonomy-course-role-attestation-v2",
    value: materialHash,
    length: 64
  });
}

export function verifyCourseRoleEvidenceMac(
  input: BoundCourseRoleEvidenceInput & {
    secret: Buffer | string;
    evidenceHash: string;
  }
): boolean {
  try {
    return constantTimeEqualHex(
      input.evidenceHash,
      computeCourseRoleEvidenceMac(input)
    );
  } catch {
    return false;
  }
}
