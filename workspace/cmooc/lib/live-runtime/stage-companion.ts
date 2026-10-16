import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import {
  canonicalJson,
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import {
  DRAFT_STAGING_CAPTURE_SCHEMA_VERSION,
  type DraftStagingCapture
} from "./draft-staging";
import { hashTransientDraftBody } from "./draft-content";

export const STAGE_COMPANION_GRANT_SCHEMA_VERSION =
  "cmooc.stage-companion-grant.v2" as const;
export const STAGE_COMPANION_TOKEN_SCHEMA_VERSION =
  "cmooc.stage-companion-token.v2" as const;
export const STAGE_COMPANION_RECEIPT_SCHEMA_VERSION =
  "cmooc.stage-companion-receipt.v2" as const;

/**
 * v2 remains explicit for the already-recorded one-shot L3 path. New
 * Workbench STAGE calls must use v3, whose grant binds a newly resolved target
 * and does not overload the source revalidation's after-observation hash.
 */
export const STAGE_COMPANION_GRANT_V3_SCHEMA_VERSION =
  "cmooc.stage-companion-grant.v3" as const;
export const STAGE_COMPANION_TOKEN_V3_SCHEMA_VERSION =
  "cmooc.stage-companion-token.v3" as const;
export const STAGE_COMPANION_RECEIPT_V3_SCHEMA_VERSION =
  "cmooc.stage-companion-receipt.v3" as const;

export type StageCompanionGrant = {
  schemaVersion:
    typeof STAGE_COMPANION_GRANT_SCHEMA_VERSION;
  courseAlias: string;
  allowedOrigin: string;
  courseLocatorHash: string;
  pageIdentityHash: string;
  driverSessionKey: string;
  opportunityReceiptHash: string;
  revalidationReceiptHash: string;
  afterObservationReceiptHash: string;
  guardReceiptHash: string;
  targetVersionHash: string;
  draftContentHash: string;
  runNonceHash: string;
  issuedAt: string;
  expiresAt: string;
  mode: "STAGE";
  remoteWriteAllowed: false;
  realPublishEnabled: false;
  containsForumText: false;
};

export type StageCompanionGrantV3 = {
  schemaVersion: typeof STAGE_COMPANION_GRANT_V3_SCHEMA_VERSION;
  courseAlias: string;
  allowedOrigin: string;
  courseLocatorHash: string;
  pageIdentityHash: string;
  driverSessionKey: string;
  opportunityReceiptHash: string;
  sourceRevalidationReceiptHash: string;
  sourceAfterObservationReceiptHash: string;
  freshObservationHash: string;
  eventSetHash: string;
  targetLocatorHash: string;
  resolvedTargetReceiptHash: string;
  resolvedAt: string;
  guardReceiptHash: string;
  targetVersionHash: string;
  draftContentHash: string;
  runNonceHash: string;
  issuedAt: string;
  expiresAt: string;
  mode: "STAGE";
  remoteWriteAllowed: false;
  realPublishEnabled: false;
  containsForumText: false;
  containsIdentity: false;
  containsSecrets: false;
};

export type SignedStageCompanionToken = {
  schemaVersion:
    typeof STAGE_COMPANION_TOKEN_SCHEMA_VERSION;
  grant: StageCompanionGrant;
  runNonce: string;
  signature: string;
  containsForumText: false;
};

export type SignedStageCompanionTokenV3 = {
  schemaVersion: typeof STAGE_COMPANION_TOKEN_V3_SCHEMA_VERSION;
  grant: StageCompanionGrantV3;
  runNonce: string;
  signature: string;
  containsForumText: false;
  containsIdentity: false;
  containsSecrets: false;
};

export type StageCompanionPageState = {
  origin: string;
  courseAlias: string;
  courseLocatorHash: string;
  pageIdentityHash: string;
  driverSessionKey: string;
  targetVersionHash: string;
  targetLocatorHash?: string;
  activeTab: true;
  pageReady: true;
  editorVisible: true;
  containsForumText: false;
};

export type StageCompanionPageStateV3 = Omit<
  StageCompanionPageState,
  "targetLocatorHash"
> & {
  targetLocatorHash: string;
};

export type StageCompanionNetworkGuard = {
  guardReceiptHash: string;
  attached: boolean;
  sentMutationCount: number;
  publishControlActivated: boolean;
  submitKeyboardShortcutUsed: boolean;
  formSubmitTriggered: boolean;
  externalPublishAttempted: boolean;
  containsForumText: boolean;
};

export type StageCompanionReceiptV2 = {
  schemaVersion:
    typeof STAGE_COMPANION_RECEIPT_SCHEMA_VERSION;
  grantHash: string;
  runNonceHash: string;
  courseAlias: string;
  courseLocatorHash: string;
  pageIdentityHash: string;
  driverSessionKey: string;
  targetVersionHash: string;
  draftContentHash: string;
  editorValueHash: string;
  guardReceiptHash: string;
  observedAt: string;
  state: "DRAFT_STAGED_VERIFIED_AND_CLEARED_NOT_PUBLISHED";
  editorWriteCount: 1;
  editorReadbackVerified: true;
  editorClearCount: 1;
  editorEmptyAfterClear: true;
  sentMutationCount: 0;
  publishAttempted: false;
  realPublishEnabled: false;
  bodyPersisted: false;
  containsForumText: false;
};

export type StageCompanionReceiptV3 = {
  schemaVersion: typeof STAGE_COMPANION_RECEIPT_V3_SCHEMA_VERSION;
  grantHash: string;
  runNonceHash: string;
  courseAlias: string;
  courseLocatorHash: string;
  pageIdentityHash: string;
  driverSessionKey: string;
  opportunityReceiptHash: string;
  sourceRevalidationReceiptHash: string;
  sourceAfterObservationReceiptHash: string;
  freshObservationHash: string;
  eventSetHash: string;
  targetLocatorHash: string;
  resolvedTargetReceiptHash: string;
  resolvedAt: string;
  targetVersionHash: string;
  draftContentHash: string;
  editorValueHash: string;
  guardReceiptHash: string;
  issuedAt: string;
  expiresAt: string;
  observedAt: string;
  state: "DRAFT_STAGED_VERIFIED_AND_CLEARED_NOT_PUBLISHED";
  editorWriteCount: 1;
  editorReadbackVerified: true;
  editorClearCount: 1;
  editorEmptyAfterClear: true;
  sentMutationCount: 0;
  publishAttempted: false;
  realPublishEnabled: false;
  bodyPersisted: false;
  containsForumText: false;
  containsIdentity: false;
  containsSecrets: false;
};

export type AnySignedStageCompanionToken =
  | SignedStageCompanionToken
  | SignedStageCompanionTokenV3;

export type AnyStageCompanionGrant =
  | StageCompanionGrant
  | StageCompanionGrantV3;

export type StageCompanionReceipt =
  | StageCompanionReceiptV2
  | StageCompanionReceiptV3;

export type AnyStageCompanionReceipt = StageCompanionReceipt;

export interface StageCompanionDriver {
  inspectPage(): Promise<StageCompanionPageState>;
  attachNoSubmitGuard(input: {
    runNonceHash: string;
    expectedGuardReceiptHash: string;
  }): Promise<StageCompanionNetworkGuard>;
  readNetworkGuard(): Promise<StageCompanionNetworkGuard>;
  writeEditor(transientDraft: string): Promise<void>;
  readEditor(): Promise<string>;
  clearEditor(): Promise<void>;
}

export type AtomicStageCompanionTransaction = {
  pageBeforeWrite: StageCompanionPageState | StageCompanionPageStateV3;
  pageAfterWrite: StageCompanionPageState | StageCompanionPageStateV3;
  pageAfterClear: StageCompanionPageState | StageCompanionPageStateV3;
  guardAfterAttach: StageCompanionNetworkGuard;
  guardAfterWrite: StageCompanionNetworkGuard;
  guardAfterClear: StageCompanionNetworkGuard;
  editorValue: string;
  editorEmptyAfterClear: boolean;
};

/**
 * A trusted browser companion can implement the complete STAGE operation as one
 * browser-side transaction. This avoids multiplying slow control-channel
 * round-trips while preserving the same page, guard, readback, and clear
 * checks used by the stepwise test driver.
 */
export interface AtomicStageCompanionDriver {
  executeStageTransaction(input: {
    runNonceHash: string;
    expectedGuardReceiptHash: string;
    transientDraft: string;
  }): Promise<AtomicStageCompanionTransaction>;
}

export type TrustedStageCompanionDriver =
  | StageCompanionDriver
  | AtomicStageCompanionDriver;

export interface StageRunNonceRegistry {
  claim(input: {
    runNonceHash: string;
    expiresAt: string;
    now: string;
  }): Promise<boolean>;
}

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const COURSE_ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const RESOLVED_TARGET_MAX_AGE_MS = 30_000;

const TOKEN_V2_KEYS = new Set([
  "schemaVersion",
  "grant",
  "runNonce",
  "signature",
  "containsForumText"
]);
const TOKEN_V3_KEYS = new Set([
  ...TOKEN_V2_KEYS,
  "containsIdentity",
  "containsSecrets"
]);
const GRANT_V2_KEYS = new Set([
  "schemaVersion",
  "courseAlias",
  "allowedOrigin",
  "courseLocatorHash",
  "pageIdentityHash",
  "driverSessionKey",
  "opportunityReceiptHash",
  "revalidationReceiptHash",
  "afterObservationReceiptHash",
  "guardReceiptHash",
  "targetVersionHash",
  "draftContentHash",
  "runNonceHash",
  "issuedAt",
  "expiresAt",
  "mode",
  "remoteWriteAllowed",
  "realPublishEnabled",
  "containsForumText"
]);
const GRANT_V3_KEYS = new Set([
  "schemaVersion",
  "courseAlias",
  "allowedOrigin",
  "courseLocatorHash",
  "pageIdentityHash",
  "driverSessionKey",
  "opportunityReceiptHash",
  "sourceRevalidationReceiptHash",
  "sourceAfterObservationReceiptHash",
  "freshObservationHash",
  "eventSetHash",
  "targetLocatorHash",
  "resolvedTargetReceiptHash",
  "resolvedAt",
  "guardReceiptHash",
  "targetVersionHash",
  "draftContentHash",
  "runNonceHash",
  "issuedAt",
  "expiresAt",
  "mode",
  "remoteWriteAllowed",
  "realPublishEnabled",
  "containsForumText",
  "containsIdentity",
  "containsSecrets"
]);
const PAGE_V2_KEYS = new Set([
  "origin",
  "courseAlias",
  "courseLocatorHash",
  "pageIdentityHash",
  "driverSessionKey",
  "targetVersionHash",
  "activeTab",
  "pageReady",
  "editorVisible",
  "containsForumText"
]);
const PAGE_V3_KEYS = new Set([...PAGE_V2_KEYS, "targetLocatorHash"]);
const GUARD_KEYS = new Set([
  "guardReceiptHash",
  "attached",
  "sentMutationCount",
  "publishControlActivated",
  "submitKeyboardShortcutUsed",
  "formSubmitTriggered",
  "externalPublishAttempted",
  "containsForumText"
]);
const RECEIPT_V3_KEYS = new Set([
  "schemaVersion",
  "grantHash",
  "runNonceHash",
  "courseAlias",
  "courseLocatorHash",
  "pageIdentityHash",
  "driverSessionKey",
  "opportunityReceiptHash",
  "sourceRevalidationReceiptHash",
  "sourceAfterObservationReceiptHash",
  "freshObservationHash",
  "eventSetHash",
  "targetLocatorHash",
  "resolvedTargetReceiptHash",
  "resolvedAt",
  "targetVersionHash",
  "draftContentHash",
  "editorValueHash",
  "guardReceiptHash",
  "issuedAt",
  "expiresAt",
  "observedAt",
  "state",
  "editorWriteCount",
  "editorReadbackVerified",
  "editorClearCount",
  "editorEmptyAfterClear",
  "sentMutationCount",
  "publishAttempted",
  "realPublishEnabled",
  "bodyPersisted",
  "containsForumText",
  "containsIdentity",
  "containsSecrets"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: unknown, expected: ReadonlySet<string>): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === expected.size &&
    keys.every((key) => expected.has(key))
  );
}

function sha256(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !HASH_PATTERN.test(value.toLowerCase())
  ) {
    throw new Error(`${label}必须是 SHA-256 十六进制摘要。`);
  }
  return value.toLowerCase();
}

function strictSha256(value: unknown, code: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new Error(code);
  }
  return value;
}

function hashTransientText(value: string): string {
  return createHash("sha256")
    .update(value, "utf8")
    .digest("hex");
}

function signingKey(secret: Buffer | string): Buffer {
  const key = Buffer.isBuffer(secret)
    ? secret
    : Buffer.from(secret, "utf8");
  if (key.byteLength < 32) {
    throw new Error("STAGE_COMPANION_SIGNING_KEY_TOO_SHORT");
  }
  return key;
}

function signGrant(
  grant: StageCompanionGrant,
  secret: Buffer | string
): string {
  return createHmac("sha256", signingKey(secret))
    .update(
      `cmooc.stage-companion-auth.v1\0${canonicalJson(
        grant as unknown as CanonicalJsonValue
      )}`,
      "utf8"
    )
    .digest("hex");
}

function signGrantV3(
  grant: StageCompanionGrantV3,
  secret: Buffer | string
): string {
  return createHmac("sha256", signingKey(secret))
    .update(
      `cmooc.stage-companion-auth.v2\0${canonicalJson(
        grant as unknown as CanonicalJsonValue
      )}`,
      "utf8"
    )
    .digest("hex");
}

function safeEqualHex(left: string, right: string): boolean {
  if (
    !HASH_PATTERN.test(left) ||
    !HASH_PATTERN.test(right)
  ) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(left, "hex"),
    Buffer.from(right, "hex")
  );
}

function normalizedOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error("STAGE_COMPANION_ORIGIN_INVALID");
  }
  return url.origin;
}

function isoTime(value: string, label: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${label}必须是有效时间。`);
  }
  return new Date(value).toISOString();
}

function canonicalIsoTime(value: unknown, code: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(code);
  }
  const normalized = new Date(value).toISOString();
  if (normalized !== value) throw new Error(code);
  return normalized;
}

function assertResolvedAtFresh(input: {
  resolvedAt: string;
  issuedAt: string;
}): void {
  const resolvedAt = Date.parse(input.resolvedAt);
  const issuedAt = Date.parse(input.issuedAt);
  if (
    resolvedAt > issuedAt ||
    issuedAt - resolvedAt > RESOLVED_TARGET_MAX_AGE_MS
  ) {
    throw new Error("STAGE_COMPANION_RESOLUTION_TIME_INVALID");
  }
}

/** @deprecated Historical one-shot L3 issuer. New Workbench runs use v3. */
export function issueStageCompanionToken(input: {
  courseAlias: string;
  allowedOrigin: string;
  courseLocatorHash: string;
  pageIdentityHash: string;
  driverSessionKey: string;
  opportunityReceiptHash: string;
  revalidationReceiptHash: string;
  afterObservationReceiptHash: string;
  guardReceiptHash: string;
  targetVersionHash: string;
  draftContentHash: string;
  signingSecret: Buffer | string;
  now: Date;
  expiresInSeconds?: number;
  nonce?: string;
}): SignedStageCompanionToken {
  if (!COURSE_ALIAS_PATTERN.test(input.courseAlias)) {
    throw new Error("STAGE_COMPANION_COURSE_ALIAS_INVALID");
  }
  const runNonce =
    input.nonce ?? randomBytes(32).toString("base64url");
  if (!NONCE_PATTERN.test(runNonce)) {
    throw new Error("STAGE_COMPANION_NONCE_INVALID");
  }
  const ttlSeconds = Math.max(
    10,
    Math.min(300, Math.floor(input.expiresInSeconds ?? 90))
  );
  const grant: StageCompanionGrant = {
    schemaVersion: STAGE_COMPANION_GRANT_SCHEMA_VERSION,
    courseAlias: input.courseAlias,
    allowedOrigin: normalizedOrigin(input.allowedOrigin),
    courseLocatorHash: sha256(
      input.courseLocatorHash,
      "课程定位"
    ),
    pageIdentityHash: sha256(
      input.pageIdentityHash,
      "页面身份"
    ),
    driverSessionKey: sha256(
      input.driverSessionKey,
      "驱动会话"
    ),
    opportunityReceiptHash: sha256(
      input.opportunityReceiptHash,
      "机会回执"
    ),
    revalidationReceiptHash: sha256(
      input.revalidationReceiptHash,
      "重读回执"
    ),
    afterObservationReceiptHash: sha256(
      input.afterObservationReceiptHash,
      "重读观察回执"
    ),
    guardReceiptHash: sha256(
      input.guardReceiptHash,
      "网络守卫回执"
    ),
    targetVersionHash: sha256(
      input.targetVersionHash,
      "目标版本"
    ),
    draftContentHash: sha256(
      input.draftContentHash,
      "草稿内容"
    ),
    runNonceHash: hashTransientText(runNonce),
    issuedAt: input.now.toISOString(),
    expiresAt: new Date(
      input.now.getTime() + ttlSeconds * 1_000
    ).toISOString(),
    mode: "STAGE",
    remoteWriteAllowed: false,
    realPublishEnabled: false,
    containsForumText: false
  };
  return {
    schemaVersion: STAGE_COMPANION_TOKEN_SCHEMA_VERSION,
    grant,
    runNonce,
    signature: signGrant(grant, input.signingSecret),
    containsForumText: false
  };
}

export function issueStageCompanionTokenV3(input: {
  courseAlias: string;
  allowedOrigin: string;
  courseLocatorHash: string;
  pageIdentityHash: string;
  driverSessionKey: string;
  opportunityReceiptHash: string;
  sourceRevalidationReceiptHash: string;
  sourceAfterObservationReceiptHash: string;
  freshObservationHash: string;
  eventSetHash: string;
  targetLocatorHash: string;
  resolvedTargetReceiptHash: string;
  resolvedAt: string;
  guardReceiptHash: string;
  targetVersionHash: string;
  draftContentHash: string;
  signingSecret: Buffer | string;
  now: Date;
  expiresInSeconds?: number;
  nonce?: string;
}): SignedStageCompanionTokenV3 {
  if (
    !COURSE_ALIAS_PATTERN.test(input.courseAlias) ||
    !Number.isFinite(input.now.getTime())
  ) {
    throw new Error("STAGE_COMPANION_V3_INPUT_INVALID");
  }
  const runNonce = input.nonce ?? randomBytes(32).toString("base64url");
  if (!NONCE_PATTERN.test(runNonce)) {
    throw new Error("STAGE_COMPANION_NONCE_INVALID");
  }
  const issuedAt = input.now.toISOString();
  const resolvedAt = canonicalIsoTime(
    input.resolvedAt,
    "STAGE_COMPANION_RESOLUTION_TIME_INVALID"
  );
  assertResolvedAtFresh({ resolvedAt, issuedAt });
  const sourceRevalidationReceiptHash = sha256(
    input.sourceRevalidationReceiptHash,
    "来源重读回执"
  );
  const sourceAfterObservationReceiptHash = sha256(
    input.sourceAfterObservationReceiptHash,
    "来源重读后观察"
  );
  const freshObservationHash = sha256(
    input.freshObservationHash,
    "写前新鲜观察"
  );
  if (
    freshObservationHash === sourceAfterObservationReceiptHash ||
    freshObservationHash === sourceRevalidationReceiptHash ||
    sourceAfterObservationReceiptHash === sourceRevalidationReceiptHash
  ) {
    throw new Error("STAGE_COMPANION_CAUSAL_BINDING_INVALID");
  }
  const requestedTtlSeconds = input.expiresInSeconds ?? 90;
  if (!Number.isFinite(requestedTtlSeconds)) {
    throw new Error("STAGE_COMPANION_V3_INPUT_INVALID");
  }
  const ttlSeconds = Math.max(
    10,
    Math.min(300, Math.floor(requestedTtlSeconds))
  );
  const grant: StageCompanionGrantV3 = {
    schemaVersion: STAGE_COMPANION_GRANT_V3_SCHEMA_VERSION,
    courseAlias: input.courseAlias,
    allowedOrigin: normalizedOrigin(input.allowedOrigin),
    courseLocatorHash: sha256(input.courseLocatorHash, "课程定位"),
    pageIdentityHash: sha256(input.pageIdentityHash, "页面身份"),
    driverSessionKey: sha256(input.driverSessionKey, "驱动会话"),
    opportunityReceiptHash: sha256(input.opportunityReceiptHash, "机会回执"),
    sourceRevalidationReceiptHash,
    sourceAfterObservationReceiptHash,
    freshObservationHash,
    eventSetHash: sha256(input.eventSetHash, "事件集合"),
    targetLocatorHash: sha256(input.targetLocatorHash, "目标定位"),
    resolvedTargetReceiptHash: sha256(
      input.resolvedTargetReceiptHash,
      "解析目标回执"
    ),
    resolvedAt,
    guardReceiptHash: sha256(input.guardReceiptHash, "网络守卫回执"),
    targetVersionHash: sha256(input.targetVersionHash, "目标版本"),
    draftContentHash: sha256(input.draftContentHash, "草稿内容"),
    runNonceHash: hashTransientText(runNonce),
    issuedAt,
    expiresAt: new Date(
      input.now.getTime() + ttlSeconds * 1_000
    ).toISOString(),
    mode: "STAGE",
    remoteWriteAllowed: false,
    realPublishEnabled: false,
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  };
  return {
    schemaVersion: STAGE_COMPANION_TOKEN_V3_SCHEMA_VERSION,
    grant,
    runNonce,
    signature: signGrantV3(grant, input.signingSecret),
    containsForumText: false,
    containsIdentity: false,
    containsSecrets: false
  };
}

export function verifyStageCompanionToken(input: {
  token: SignedStageCompanionToken;
  signingSecret: Buffer | string;
  now: Date;
}): {
  grant: StageCompanionGrant;
  grantHash: string;
};
export function verifyStageCompanionToken(input: {
  token: SignedStageCompanionTokenV3;
  signingSecret: Buffer | string;
  now: Date;
}): {
  grant: StageCompanionGrantV3;
  grantHash: string;
};
export function verifyStageCompanionToken(input: {
  token: AnySignedStageCompanionToken;
  signingSecret: Buffer | string;
  now: Date;
}): {
  grant: AnyStageCompanionGrant;
  grantHash: string;
};
export function verifyStageCompanionToken(input: {
  token: AnySignedStageCompanionToken;
  signingSecret: Buffer | string;
  now: Date;
}): {
  grant: AnyStageCompanionGrant;
  grantHash: string;
} {
  const { token } = input;
  if (!isRecord(token) || !isRecord(token.grant)) {
    throw new Error("STAGE_COMPANION_TOKEN_INVALID");
  }
  const v3 =
    token.schemaVersion === STAGE_COMPANION_TOKEN_V3_SCHEMA_VERSION &&
    token.grant.schemaVersion === STAGE_COMPANION_GRANT_V3_SCHEMA_VERSION;
  const v2 =
    token.schemaVersion === STAGE_COMPANION_TOKEN_SCHEMA_VERSION &&
    token.grant.schemaVersion === STAGE_COMPANION_GRANT_SCHEMA_VERSION;
  if (
    (!v2 && !v3) ||
    (v3 &&
      (!hasExactKeys(token, TOKEN_V3_KEYS) ||
        !hasExactKeys(token.grant, GRANT_V3_KEYS))) ||
    token.containsForumText !== false ||
    token.grant.containsForumText !== false ||
    token.grant.mode !== "STAGE" ||
    token.grant.remoteWriteAllowed !== false ||
    token.grant.realPublishEnabled !== false ||
    (v3 &&
      ((token as SignedStageCompanionTokenV3).containsIdentity !== false ||
        (token as SignedStageCompanionTokenV3).containsSecrets !== false ||
        (token.grant as StageCompanionGrantV3).containsIdentity !== false ||
        (token.grant as StageCompanionGrantV3).containsSecrets !== false)) ||
    !COURSE_ALIAS_PATTERN.test(token.grant.courseAlias) ||
    !NONCE_PATTERN.test(token.runNonce) ||
    hashTransientText(token.runNonce) !== token.grant.runNonceHash
  ) {
    throw new Error("STAGE_COMPANION_TOKEN_INVALID");
  }
  try {
    const canonicalOrigin = normalizedOrigin(token.grant.allowedOrigin);
    if (v3 && canonicalOrigin !== token.grant.allowedOrigin) {
      throw new Error("STAGE_COMPANION_TOKEN_INVALID");
    }
    for (const value of [
      token.grant.courseLocatorHash,
      token.grant.pageIdentityHash,
      token.grant.driverSessionKey,
      token.grant.opportunityReceiptHash,
      token.grant.guardReceiptHash,
      token.grant.targetVersionHash,
      token.grant.draftContentHash,
      token.grant.runNonceHash,
      ...(v3
        ? [
            (token.grant as StageCompanionGrantV3)
              .sourceRevalidationReceiptHash,
            (token.grant as StageCompanionGrantV3)
              .sourceAfterObservationReceiptHash,
            (token.grant as StageCompanionGrantV3).freshObservationHash,
            (token.grant as StageCompanionGrantV3).eventSetHash,
            (token.grant as StageCompanionGrantV3).targetLocatorHash,
            (token.grant as StageCompanionGrantV3)
              .resolvedTargetReceiptHash
          ]
        : [
            (token.grant as StageCompanionGrant).revalidationReceiptHash,
            (token.grant as StageCompanionGrant).afterObservationReceiptHash
          ])
    ]) {
      if (v3) strictSha256(value, "STAGE_COMPANION_TOKEN_INVALID");
      else sha256(value, "STAGE grant hash");
    }
  } catch {
    throw new Error("STAGE_COMPANION_TOKEN_INVALID");
  }
  if (v3) {
    const grant = token.grant as StageCompanionGrantV3;
    if (
      grant.freshObservationHash ===
        grant.sourceAfterObservationReceiptHash ||
      grant.freshObservationHash ===
        grant.sourceRevalidationReceiptHash ||
      grant.sourceAfterObservationReceiptHash ===
        grant.sourceRevalidationReceiptHash
    ) {
      throw new Error("STAGE_COMPANION_CAUSAL_BINDING_INVALID");
    }
  }
  const expected = v3
    ? signGrantV3(
        token.grant as StageCompanionGrantV3,
        input.signingSecret
      )
    : signGrant(
        token.grant as StageCompanionGrant,
        input.signingSecret
      );
  if (!safeEqualHex(token.signature, expected)) {
    throw new Error("STAGE_COMPANION_TOKEN_AUTH_FAILED");
  }
  let issuedAtIso: string;
  let expiresAtIso: string;
  try {
    issuedAtIso = canonicalIsoTime(
      token.grant.issuedAt,
      "STAGE_COMPANION_TOKEN_TIME_INVALID"
    );
    expiresAtIso = canonicalIsoTime(
      token.grant.expiresAt,
      "STAGE_COMPANION_TOKEN_TIME_INVALID"
    );
  } catch {
    throw new Error("STAGE_COMPANION_TOKEN_TIME_INVALID");
  }
  const issuedAt = Date.parse(issuedAtIso);
  const expiresAt = Date.parse(expiresAtIso);
  if (
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > 300_000 ||
    input.now.getTime() < issuedAt ||
    input.now.getTime() >= expiresAt
  ) {
    throw new Error("STAGE_COMPANION_TOKEN_EXPIRED");
  }
  if (v3) {
    const grant = token.grant as StageCompanionGrantV3;
    let resolvedAt: string;
    try {
      resolvedAt = canonicalIsoTime(
        grant.resolvedAt,
        "STAGE_COMPANION_RESOLUTION_TIME_INVALID"
      );
      assertResolvedAtFresh({ resolvedAt, issuedAt: issuedAtIso });
    } catch {
      throw new Error("STAGE_COMPANION_RESOLUTION_TIME_INVALID");
    }
    if (input.now.getTime() < Date.parse(resolvedAt)) {
      throw new Error("STAGE_COMPANION_TARGET_NOT_YET_RESOLVED");
    }
  }
  return {
    grant: token.grant,
    grantHash: canonicalProtocolHash(
      token.grant.schemaVersion,
      token.grant as unknown as CanonicalJsonValue
    )
  };
}

/**
 * Verifies a durable v3 receipt without needing transient draft text, target
 * URL, identity, credentials, or browser state. Callers that still hold the
 * signed grant can additionally require exact grant-to-receipt causality.
 */
export function verifyStageCompanionReceiptV3(input: {
  receipt: StageCompanionReceiptV3;
  receiptHash: string;
  grant?: StageCompanionGrantV3;
}): StageCompanionReceiptV3 {
  const receipt = input.receipt;
  if (
    !hasExactKeys(receipt, RECEIPT_V3_KEYS) ||
    receipt.schemaVersion !== STAGE_COMPANION_RECEIPT_V3_SCHEMA_VERSION ||
    !COURSE_ALIAS_PATTERN.test(receipt.courseAlias) ||
    receipt.state !==
      "DRAFT_STAGED_VERIFIED_AND_CLEARED_NOT_PUBLISHED" ||
    receipt.editorWriteCount !== 1 ||
    receipt.editorReadbackVerified !== true ||
    receipt.editorClearCount !== 1 ||
    receipt.editorEmptyAfterClear !== true ||
    receipt.sentMutationCount !== 0 ||
    receipt.publishAttempted !== false ||
    receipt.realPublishEnabled !== false ||
    receipt.bodyPersisted !== false ||
    receipt.containsForumText !== false ||
    receipt.containsIdentity !== false ||
    receipt.containsSecrets !== false ||
    receipt.editorValueHash !== receipt.draftContentHash
  ) {
    throw new Error("STAGE_COMPANION_RECEIPT_V3_INVALID");
  }
  try {
    for (const value of [
      receipt.grantHash,
      receipt.runNonceHash,
      receipt.courseLocatorHash,
      receipt.pageIdentityHash,
      receipt.driverSessionKey,
      receipt.opportunityReceiptHash,
      receipt.sourceRevalidationReceiptHash,
      receipt.sourceAfterObservationReceiptHash,
      receipt.freshObservationHash,
      receipt.eventSetHash,
      receipt.targetLocatorHash,
      receipt.resolvedTargetReceiptHash,
      receipt.targetVersionHash,
      receipt.draftContentHash,
      receipt.editorValueHash,
      receipt.guardReceiptHash
    ]) {
      strictSha256(value, "STAGE_COMPANION_RECEIPT_V3_INVALID");
    }
    const resolvedAt = canonicalIsoTime(
      receipt.resolvedAt,
      "STAGE_COMPANION_RECEIPT_V3_INVALID"
    );
    const issuedAt = canonicalIsoTime(
      receipt.issuedAt,
      "STAGE_COMPANION_RECEIPT_V3_INVALID"
    );
    const expiresAt = canonicalIsoTime(
      receipt.expiresAt,
      "STAGE_COMPANION_RECEIPT_V3_INVALID"
    );
    const observedAt = canonicalIsoTime(
      receipt.observedAt,
      "STAGE_COMPANION_RECEIPT_V3_INVALID"
    );
    assertResolvedAtFresh({ resolvedAt, issuedAt });
    if (
      Date.parse(expiresAt) <= Date.parse(issuedAt) ||
      Date.parse(expiresAt) - Date.parse(issuedAt) > 300_000 ||
      Date.parse(observedAt) < Date.parse(resolvedAt) ||
      Date.parse(observedAt) < Date.parse(issuedAt) ||
      Date.parse(observedAt) >= Date.parse(expiresAt)
    ) {
      throw new Error("STAGE_COMPANION_RECEIPT_V3_INVALID");
    }
  } catch {
    throw new Error("STAGE_COMPANION_RECEIPT_V3_INVALID");
  }
  if (
    receipt.freshObservationHash ===
      receipt.sourceAfterObservationReceiptHash ||
    receipt.freshObservationHash ===
      receipt.sourceRevalidationReceiptHash ||
    receipt.sourceAfterObservationReceiptHash ===
      receipt.sourceRevalidationReceiptHash ||
    canonicalProtocolHash(
      receipt.schemaVersion,
      receipt as unknown as CanonicalJsonValue
    ) !== strictSha256(
      input.receiptHash,
      "STAGE_COMPANION_RECEIPT_V3_INVALID"
    )
  ) {
    throw new Error("STAGE_COMPANION_RECEIPT_V3_INVALID");
  }
  if (input.grant) {
    const grant = input.grant;
    const grantHash = canonicalProtocolHash(
      grant.schemaVersion,
      grant as unknown as CanonicalJsonValue
    );
    if (
      !hasExactKeys(grant, GRANT_V3_KEYS) ||
      grant.schemaVersion !== STAGE_COMPANION_GRANT_V3_SCHEMA_VERSION ||
      grant.mode !== "STAGE" ||
      grant.remoteWriteAllowed !== false ||
      grant.realPublishEnabled !== false ||
      grant.containsForumText !== false ||
      grant.containsIdentity !== false ||
      grant.containsSecrets !== false ||
      receipt.grantHash !== grantHash ||
      receipt.runNonceHash !== grant.runNonceHash ||
      receipt.courseAlias !== grant.courseAlias ||
      receipt.courseLocatorHash !== grant.courseLocatorHash ||
      receipt.pageIdentityHash !== grant.pageIdentityHash ||
      receipt.driverSessionKey !== grant.driverSessionKey ||
      receipt.opportunityReceiptHash !== grant.opportunityReceiptHash ||
      receipt.sourceRevalidationReceiptHash !==
        grant.sourceRevalidationReceiptHash ||
      receipt.sourceAfterObservationReceiptHash !==
        grant.sourceAfterObservationReceiptHash ||
      receipt.freshObservationHash !== grant.freshObservationHash ||
      receipt.eventSetHash !== grant.eventSetHash ||
      receipt.targetLocatorHash !== grant.targetLocatorHash ||
      receipt.resolvedTargetReceiptHash !==
        grant.resolvedTargetReceiptHash ||
      receipt.resolvedAt !== grant.resolvedAt ||
      receipt.targetVersionHash !== grant.targetVersionHash ||
      receipt.draftContentHash !== grant.draftContentHash ||
      receipt.guardReceiptHash !== grant.guardReceiptHash ||
      receipt.issuedAt !== grant.issuedAt ||
      receipt.expiresAt !== grant.expiresAt
    ) {
      throw new Error("STAGE_COMPANION_RECEIPT_V3_GRANT_MISMATCH");
    }
  }
  return Object.freeze({ ...receipt });
}

function assertPageBinding(
  state: StageCompanionPageState | StageCompanionPageStateV3,
  grant: AnyStageCompanionGrant
): void {
  const v3 = grant.schemaVersion === STAGE_COMPANION_GRANT_V3_SCHEMA_VERSION;
  if (
    (v3 && !hasExactKeys(state, PAGE_V3_KEYS)) ||
    (v3 &&
      [
        state.courseLocatorHash,
        state.pageIdentityHash,
        state.driverSessionKey,
        state.targetVersionHash,
        (state as StageCompanionPageStateV3).targetLocatorHash
      ].some((value) =>
        typeof value !== "string" || !HASH_PATTERN.test(value)
      )) ||
    state.containsForumText !== false ||
    state.activeTab !== true ||
    state.pageReady !== true ||
    state.editorVisible !== true ||
    normalizedOrigin(state.origin) !== grant.allowedOrigin ||
    state.courseAlias !== grant.courseAlias ||
    sha256(state.courseLocatorHash, "页面课程定位") !==
      grant.courseLocatorHash ||
    sha256(state.pageIdentityHash, "页面身份") !==
      grant.pageIdentityHash ||
    sha256(state.driverSessionKey, "驱动会话") !==
      grant.driverSessionKey ||
    sha256(state.targetVersionHash, "目标版本") !==
      grant.targetVersionHash ||
    (v3 &&
      sha256(
        (state as StageCompanionPageStateV3).targetLocatorHash,
        "目标定位"
      ) !== (grant as StageCompanionGrantV3).targetLocatorHash)
  ) {
    throw new Error("STAGE_COMPANION_PAGE_GUARD_MISMATCH");
  }
}

function assertNoSubmitGuard(
  guard: StageCompanionNetworkGuard,
  grant: AnyStageCompanionGrant
): void {
  if (
    (grant.schemaVersion === STAGE_COMPANION_GRANT_V3_SCHEMA_VERSION &&
      (!hasExactKeys(guard, GUARD_KEYS) ||
        typeof guard.guardReceiptHash !== "string" ||
        !HASH_PATTERN.test(guard.guardReceiptHash))) ||
    guard.containsForumText !== false ||
    guard.attached !== true ||
    guard.guardReceiptHash !== grant.guardReceiptHash ||
    guard.sentMutationCount !== 0 ||
    guard.publishControlActivated !== false ||
    guard.submitKeyboardShortcutUsed !== false ||
    guard.formSubmitTriggered !== false ||
    guard.externalPublishAttempted !== false
  ) {
    throw new Error("STAGE_COMPANION_NO_SUBMIT_GUARD_FAILED");
  }
}

export type StageCompanionRunResultV2 = {
  capture: DraftStagingCapture;
  receipt: StageCompanionReceiptV2;
  receiptHash: string;
};

export type StageCompanionRunResultV3 = {
  capture: DraftStagingCapture;
  receipt: StageCompanionReceiptV3;
  receiptHash: string;
};

type StageCompanionRunInput<Token extends AnySignedStageCompanionToken> = {
  token: Token;
  signingSecret: Buffer | string;
  nonceRegistry: StageRunNonceRegistry;
  driver: TrustedStageCompanionDriver;
  transientDraft: string;
  now: () => Date;
};

export function executeStageCompanionRun(
  input: StageCompanionRunInput<SignedStageCompanionToken>
): Promise<StageCompanionRunResultV2>;
export function executeStageCompanionRun(
  input: StageCompanionRunInput<SignedStageCompanionTokenV3>
): Promise<StageCompanionRunResultV3>;
export function executeStageCompanionRun(
  input: StageCompanionRunInput<AnySignedStageCompanionToken>
): Promise<StageCompanionRunResultV2 | StageCompanionRunResultV3>;
export async function executeStageCompanionRun(input: {
  token: AnySignedStageCompanionToken;
  signingSecret: Buffer | string;
  nonceRegistry: StageRunNonceRegistry;
  driver: TrustedStageCompanionDriver;
  transientDraft: string;
  now: () => Date;
}): Promise<{
  capture: DraftStagingCapture;
  receipt: AnyStageCompanionReceipt;
  receiptHash: string;
}> {
  const verified = verifyStageCompanionToken({
    token: input.token,
    signingSecret: input.signingSecret,
    now: input.now()
  });
  const grant = verified.grant;
  if (
    hashTransientDraftBody(input.transientDraft) !==
    grant.draftContentHash
  ) {
    throw new Error("STAGE_COMPANION_DRAFT_HASH_MISMATCH");
  }
  const claimed = await input.nonceRegistry.claim({
    runNonceHash: grant.runNonceHash,
    expiresAt: grant.expiresAt,
    now: input.now().toISOString()
  });
  if (!claimed) {
    throw new Error("STAGE_COMPANION_NONCE_ALREADY_USED");
  }

  let writeVerified = false;
  let clearVerified = false;
  if ("executeStageTransaction" in input.driver) {
    const transaction =
      await input.driver.executeStageTransaction({
        runNonceHash: grant.runNonceHash,
        expectedGuardReceiptHash:
          grant.guardReceiptHash,
        transientDraft: input.transientDraft
      });
    assertPageBinding(transaction.pageBeforeWrite, grant);
    assertNoSubmitGuard(transaction.guardAfterAttach, grant);
    writeVerified =
      hashTransientDraftBody(transaction.editorValue) ===
      grant.draftContentHash;
    assertPageBinding(transaction.pageAfterWrite, grant);
    assertNoSubmitGuard(transaction.guardAfterWrite, grant);
    clearVerified = transaction.editorEmptyAfterClear;
    assertPageBinding(transaction.pageAfterClear, grant);
    assertNoSubmitGuard(transaction.guardAfterClear, grant);
    if (!writeVerified) {
      throw new Error(
        "STAGE_COMPANION_EDITOR_READBACK_MISMATCH"
      );
    }
  } else {
    const before = await input.driver.inspectPage();
    assertPageBinding(before, grant);
    const attached = await input.driver.attachNoSubmitGuard({
      runNonceHash: grant.runNonceHash,
      expectedGuardReceiptHash:
        grant.guardReceiptHash
    });
    assertNoSubmitGuard(attached, grant);
    try {
      await input.driver.writeEditor(input.transientDraft);
      const editorValue = await input.driver.readEditor();
      writeVerified =
        hashTransientDraftBody(editorValue) ===
        grant.draftContentHash;
      if (!writeVerified) {
        throw new Error(
          "STAGE_COMPANION_EDITOR_READBACK_MISMATCH"
        );
      }
      assertPageBinding(
        await input.driver.inspectPage(),
        grant
      );
      assertNoSubmitGuard(
        await input.driver.readNetworkGuard(),
        grant
      );
    } finally {
      await input.driver.clearEditor();
      clearVerified =
        (await input.driver.readEditor()) === "";
    }
    assertPageBinding(await input.driver.inspectPage(), grant);
    assertNoSubmitGuard(
      await input.driver.readNetworkGuard(),
      grant
    );
  }
  if (!clearVerified) {
    throw new Error("STAGE_COMPANION_EDITOR_CLEAR_FAILED");
  }
  const observedAt = input.now();
  if (
    observedAt.getTime() >= Date.parse(grant.expiresAt) ||
    (grant.schemaVersion === STAGE_COMPANION_GRANT_V3_SCHEMA_VERSION &&
      observedAt.getTime() < Date.parse(grant.resolvedAt)) ||
    !writeVerified
  ) {
    throw new Error("STAGE_COMPANION_RUN_EXPIRED");
  }
  const capture: DraftStagingCapture = {
    schemaVersion: DRAFT_STAGING_CAPTURE_SCHEMA_VERSION,
    opportunityReceiptHash: grant.opportunityReceiptHash,
    revalidationReceiptHash:
      grant.schemaVersion === STAGE_COMPANION_GRANT_V3_SCHEMA_VERSION
        ? grant.sourceRevalidationReceiptHash
        : grant.revalidationReceiptHash,
    afterObservationReceiptHash:
      grant.schemaVersion === STAGE_COMPANION_GRANT_V3_SCHEMA_VERSION
        ? grant.sourceAfterObservationReceiptHash
        : grant.afterObservationReceiptHash,
    guardReceiptHash: grant.guardReceiptHash,
    observedAt: observedAt.toISOString(),
    targetVersionHash: grant.targetVersionHash,
    draftContentHash: grant.draftContentHash,
    editorValueHash: grant.draftContentHash,
    editorWriteOutcome: "verified",
    networkGuardAttachedBeforeTyping: true,
    localUiMutationPerformed: true,
    remoteWriteSent: false,
    sentMutationCount: 0,
    publishControlActivated: false,
    submitKeyboardShortcutUsed: false,
    formSubmitTriggered: false,
    publishNetworkRequestCount: 0,
    externalPublishAttempted: false,
    containsForumText: false
  };
  const commonReceipt = {
    grantHash: verified.grantHash,
    runNonceHash: grant.runNonceHash,
    courseAlias: grant.courseAlias,
    courseLocatorHash: grant.courseLocatorHash,
    pageIdentityHash: grant.pageIdentityHash,
    driverSessionKey: grant.driverSessionKey,
    targetVersionHash: grant.targetVersionHash,
    draftContentHash: grant.draftContentHash,
    editorValueHash: grant.draftContentHash,
    guardReceiptHash: grant.guardReceiptHash,
    observedAt: observedAt.toISOString(),
    state:
      "DRAFT_STAGED_VERIFIED_AND_CLEARED_NOT_PUBLISHED" as const,
    editorWriteCount: 1 as const,
    editorReadbackVerified: true as const,
    editorClearCount: 1 as const,
    editorEmptyAfterClear: true as const,
    sentMutationCount: 0 as const,
    publishAttempted: false as const,
    realPublishEnabled: false as const,
    bodyPersisted: false as const,
    containsForumText: false as const
  };
  const receipt: AnyStageCompanionReceipt =
    grant.schemaVersion === STAGE_COMPANION_GRANT_V3_SCHEMA_VERSION
      ? {
          schemaVersion: STAGE_COMPANION_RECEIPT_V3_SCHEMA_VERSION,
          ...commonReceipt,
          opportunityReceiptHash: grant.opportunityReceiptHash,
          sourceRevalidationReceiptHash:
            grant.sourceRevalidationReceiptHash,
          sourceAfterObservationReceiptHash:
            grant.sourceAfterObservationReceiptHash,
          freshObservationHash: grant.freshObservationHash,
          eventSetHash: grant.eventSetHash,
          targetLocatorHash: grant.targetLocatorHash,
          resolvedTargetReceiptHash:
            grant.resolvedTargetReceiptHash,
          resolvedAt: grant.resolvedAt,
          issuedAt: grant.issuedAt,
          expiresAt: grant.expiresAt,
          containsIdentity: false,
          containsSecrets: false
        }
      : {
          schemaVersion: STAGE_COMPANION_RECEIPT_SCHEMA_VERSION,
          ...commonReceipt
        };
  const receiptHash = canonicalProtocolHash(
    receipt.schemaVersion,
    receipt as unknown as CanonicalJsonValue
  );
  if (
    receipt.schemaVersion === STAGE_COMPANION_RECEIPT_V3_SCHEMA_VERSION &&
    grant.schemaVersion === STAGE_COMPANION_GRANT_V3_SCHEMA_VERSION
  ) {
    verifyStageCompanionReceiptV3({
      receipt,
      receiptHash,
      grant
    });
  }
  return {
    capture,
    receipt,
    receiptHash
  };
}

export class InMemoryStageRunNonceRegistry
implements StageRunNonceRegistry {
  private readonly claimed = new Set<string>();

  async claim(input: {
    runNonceHash: string;
    expiresAt: string;
    now: string;
  }): Promise<boolean> {
    const nonceHash = sha256(
      input.runNonceHash,
      "STAGE run nonce"
    );
    if (
      Date.parse(input.now) >= Date.parse(input.expiresAt) ||
      this.claimed.has(nonceHash)
    ) {
      return false;
    }
    this.claimed.add(nonceHash);
    return true;
  }
}

export class SimulatedStageCompanionDriver
implements StageCompanionDriver {
  private editorValue = "";
  private guardAttached = false;
  readonly counters = {
    writes: 0,
    reads: 0,
    clears: 0
  };

  constructor(
    private readonly state: StageCompanionPageState,
    private readonly guardReceiptHash: string
  ) {}

  async inspectPage(): Promise<StageCompanionPageState> {
    return { ...this.state };
  }

  async attachNoSubmitGuard(input: {
    runNonceHash: string;
    expectedGuardReceiptHash: string;
  }): Promise<StageCompanionNetworkGuard> {
    sha256(input.runNonceHash, "STAGE run nonce");
    if (
      input.expectedGuardReceiptHash !==
      this.guardReceiptHash
    ) {
      throw new Error(
        "STAGE_COMPANION_SIMULATED_GUARD_MISMATCH"
      );
    }
    this.guardAttached = true;
    return this.guard();
  }

  async readNetworkGuard(): Promise<StageCompanionNetworkGuard> {
    if (!this.guardAttached) {
      throw new Error(
        "STAGE_COMPANION_GUARD_NOT_ATTACHED"
      );
    }
    return this.guard();
  }

  async writeEditor(transientDraft: string): Promise<void> {
    if (!this.guardAttached) {
      throw new Error(
        "STAGE_COMPANION_GUARD_NOT_ATTACHED"
      );
    }
    this.counters.writes += 1;
    this.editorValue = transientDraft;
  }

  async readEditor(): Promise<string> {
    this.counters.reads += 1;
    return this.editorValue;
  }

  async clearEditor(): Promise<void> {
    this.counters.clears += 1;
    this.editorValue = "";
  }

  private guard(): StageCompanionNetworkGuard {
    return {
      guardReceiptHash: this.guardReceiptHash,
      attached: true,
      sentMutationCount: 0,
      publishControlActivated: false,
      submitKeyboardShortcutUsed: false,
      formSubmitTriggered: false,
      externalPublishAttempted: false,
      containsForumText: false
    };
  }
}
