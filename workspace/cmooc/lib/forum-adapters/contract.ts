import {
  TARGET_OBJECTS,
  type BoundTargetV1,
  type ExecutionCommandV1,
  type ExecutionReceiptV1,
  type ObservationEnvelopeV1,
  type TargetObject
} from "../facilitation-protocol";

export const FORUM_ADAPTER_CONTRACT_VERSION =
  "cmooc.forum-adapter-contract.v1" as const;
export const ADAPTER_MANIFEST_SCHEMA_VERSION =
  "cmooc.forum-adapter-manifest.v1" as const;
export const AUTH_SUMMARY_SCHEMA_VERSION =
  "cmooc.forum-adapter-auth-summary.v1" as const;
export const THREAD_PAGE_SCHEMA_VERSION =
  "cmooc.forum-thread-page.v1" as const;
export const PREFLIGHT_RECEIPT_SCHEMA_VERSION =
  "cmooc.forum-adapter-preflight-receipt.v1" as const;

export type AdapterTransport = "api" | "mock" | "browser_diagnostic";
export type ExternalWriteMode =
  | "none"
  | "synthetic_only"
  | "gateway_authorized";

export interface AdapterManifest {
  schemaVersion: typeof ADAPTER_MANIFEST_SCHEMA_VERSION;
  contractVersion: typeof FORUM_ADAPTER_CONTRACT_VERSION;
  adapterId: string;
  adapterVersion: string;
  platformId: string;
  transport: AdapterTransport;
  externalWriteMode: ExternalWriteMode;
  supportsVirtualClock: boolean;
  capabilities: {
    inspectAuth: true;
    listThreads: true;
    observeThread: true;
    bindTarget: true;
    preflight: true;
    executeAuthorized: boolean;
  };
  containsForumText: false;
}

export type AdapterAuthStatus =
  | "authenticated"
  | "unauthenticated"
  | "unknown"
  | "not_applicable";

export interface AuthSummary {
  schemaVersion: typeof AUTH_SUMMARY_SCHEMA_VERSION;
  adapterId: string;
  adapterVersion: string;
  status: AdapterAuthStatus;
  canRead: boolean;
  canExecuteAuthorized: boolean;
  checkedAt: string;
  evidenceHash: string;
  messageCode: string;
  containsForumText: false;
}

export interface ForumScope {
  courseKey: string;
  platformCourseRef: string;
  locator?: string;
  limit?: number;
}

export interface ThreadRef {
  threadKey: string;
  courseKey: string;
  platformCourseRef: string;
  stableThreadRef: string;
  locator: string;
}

export interface ThreadSummary {
  threadRef: ThreadRef;
  titleHash: string;
  stateHintHash: string;
  replyCount: number;
  latestEventAt: string | null;
  containsForumText: false;
}

export interface ThreadPage {
  schemaVersion: typeof THREAD_PAGE_SCHEMA_VERSION;
  adapterId: string;
  adapterVersion: string;
  courseKey: string;
  observedAt: string;
  items: ThreadSummary[];
  nextCursor: string | null;
  containsForumText: false;
}

export interface TargetRef {
  thread: ThreadRef;
  targetType: "thread" | "comment";
  targetObject: Exclude<TargetObject, null>;
  stableTargetRef: string;
}

export type PreflightStatus =
  | "ready"
  | "denied"
  | "target_changed"
  | "command_expired";

export interface PreflightReceipt {
  schemaVersion: typeof PREFLIGHT_RECEIPT_SCHEMA_VERSION;
  adapterId: string;
  adapterVersion: string;
  commandId: string;
  status: PreflightStatus;
  expectedTargetHash: string;
  checkedAt: string;
  evidenceHash: string;
  messageCode: string;
  containsForumText: false;
}

export interface ForumAdapter {
  manifest(): AdapterManifest;
  inspectAuth(): Promise<AuthSummary>;
  listThreads(
    scope: ForumScope,
    cursor?: string
  ): Promise<ThreadPage>;
  observeThread(ref: ThreadRef): Promise<ObservationEnvelopeV1>;
  bindTarget(ref: TargetRef): Promise<BoundTargetV1>;
  preflight(command: ExecutionCommandV1): Promise<PreflightReceipt>;
  executeAuthorized(
    command: ExecutionCommandV1
  ): Promise<ExecutionReceiptV1>;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ISO_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/;

function assertIdentifier(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new Error(`INVALID_ADAPTER_IDENTIFIER: ${label} 非法。`);
  }
}

function assertRecord(
  value: unknown,
  code: string
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error(code);
  }
  return value as Record<string, unknown>;
}

function assertExactFields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  code: string
): Record<string, unknown> {
  const record = assertRecord(value, code);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((field) => !Object.hasOwn(record, field)) ||
    Object.keys(record).some((field) => !allowed.has(field))
  ) {
    throw new Error(code);
  }
  return record;
}

function assertIsoDateTime(value: string, label: string): void {
  const match =
    typeof value === "string"
      ? ISO_DATE_TIME_PATTERN.exec(value)
      : null;
  if (
    match === null ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`INVALID_ADAPTER_TIME: ${label}`);
  }
  const [, year, month, day, hour, minute, second, , , offsetHour, offsetMinute] =
    match;
  const numericYear = Number(year);
  const numericMonth = Number(month);
  const numericDay = Number(day);
  const daysInMonth = new Date(
    Date.UTC(numericYear, numericMonth, 0)
  ).getUTCDate();
  if (
    numericMonth < 1 ||
    numericMonth > 12 ||
    numericDay < 1 ||
    numericDay > daysInMonth ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    (offsetHour !== undefined &&
      (Number(offsetHour) > 14 ||
        Number(offsetMinute) > 59 ||
        (Number(offsetHour) === 14 &&
          Number(offsetMinute) !== 0)))
  ) {
    throw new Error(`INVALID_ADAPTER_TIME: ${label}`);
  }
}

export function assertAdapterManifest(
  manifest: AdapterManifest
): AdapterManifest {
  const rootFields = [
    "schemaVersion",
    "contractVersion",
    "adapterId",
    "adapterVersion",
    "platformId",
    "transport",
    "externalWriteMode",
    "supportsVirtualClock",
    "capabilities",
    "containsForumText"
  ];
  assertExactFields(
    manifest,
    rootFields,
    [],
    "INVALID_ADAPTER_MANIFEST_FIELDS"
  );
  if (
    manifest.schemaVersion !== ADAPTER_MANIFEST_SCHEMA_VERSION ||
    manifest.contractVersion !== FORUM_ADAPTER_CONTRACT_VERSION
  ) {
    throw new Error("ADAPTER_CONTRACT_VERSION_MISMATCH");
  }
  assertIdentifier(manifest.adapterId, "adapterId");
  assertIdentifier(manifest.adapterVersion, "adapterVersion");
  assertIdentifier(manifest.platformId, "platformId");
  if (!["api", "mock", "browser_diagnostic"].includes(manifest.transport)) {
    throw new Error("INVALID_ADAPTER_TRANSPORT");
  }
  if (
    !["none", "synthetic_only", "gateway_authorized"].includes(
      manifest.externalWriteMode
    )
  ) {
    throw new Error("INVALID_EXTERNAL_WRITE_MODE");
  }
  if (typeof manifest.supportsVirtualClock !== "boolean") {
    throw new Error("INVALID_VIRTUAL_CLOCK_CAPABILITY");
  }
  const capabilityFields = [
    "inspectAuth",
    "listThreads",
    "observeThread",
    "bindTarget",
    "preflight",
    "executeAuthorized"
  ];
  const capabilities = assertExactFields(
    manifest.capabilities,
    capabilityFields,
    [],
    "INVALID_ADAPTER_CAPABILITIES"
  );
  if (
    capabilityFields.some(
      (field) => typeof capabilities[field] !== "boolean"
    )
  ) {
    throw new Error("INVALID_ADAPTER_CAPABILITIES");
  }
  for (const requiredCapability of capabilityFields.slice(0, 5)) {
    if (
      manifest.capabilities[
        requiredCapability as keyof AdapterManifest["capabilities"]
      ] !== true
    ) {
      throw new Error("REQUIRED_ADAPTER_CAPABILITY_MISSING");
    }
  }
  if (manifest.containsForumText !== false) {
    throw new Error("ADAPTER_MANIFEST_CONTAINS_FORUM_TEXT");
  }
  if (
    manifest.externalWriteMode === "none" &&
    manifest.capabilities.executeAuthorized
  ) {
    throw new Error("READ_ONLY_ADAPTER_ADVERTISES_EXECUTION");
  }
  if (
    manifest.externalWriteMode !== "none" &&
    !manifest.capabilities.executeAuthorized
  ) {
    throw new Error("EXECUTION_MODE_WITHOUT_CAPABILITY");
  }
  if (
    manifest.transport === "browser_diagnostic" &&
    manifest.externalWriteMode !== "none"
  ) {
    throw new Error("BROWSER_DIAGNOSTIC_WRITE_FORBIDDEN");
  }
  if (
    manifest.externalWriteMode === "synthetic_only" &&
    (manifest.transport !== "mock" ||
      !manifest.platformId.startsWith("synthetic.") ||
      manifest.supportsVirtualClock !== true)
  ) {
    throw new Error("INVALID_SYNTHETIC_ADAPTER_BOUNDARY");
  }
  return manifest;
}

export function assertForumScope(scope: ForumScope): ForumScope {
  assertExactFields(
    scope,
    ["courseKey", "platformCourseRef"],
    ["locator", "limit"],
    "INVALID_FORUM_SCOPE_FIELDS"
  );
  assertIdentifier(scope.courseKey, "courseKey");
  assertIdentifier(scope.platformCourseRef, "platformCourseRef");
  if (
    scope.locator !== undefined &&
    (typeof scope.locator !== "string" || !scope.locator.trim())
  ) {
    throw new Error("INVALID_FORUM_SCOPE_LOCATOR");
  }
  if (
    scope.limit !== undefined &&
    (!Number.isSafeInteger(scope.limit) ||
      scope.limit < 1 ||
      scope.limit > 100)
  ) {
    throw new Error("INVALID_FORUM_SCOPE_LIMIT");
  }
  return scope;
}

export function assertThreadRef(ref: ThreadRef): ThreadRef {
  assertExactFields(
    ref,
    [
      "threadKey",
      "courseKey",
      "platformCourseRef",
      "stableThreadRef",
      "locator"
    ],
    [],
    "INVALID_THREAD_REF_FIELDS"
  );
  assertIdentifier(ref.threadKey, "threadKey");
  assertIdentifier(ref.courseKey, "courseKey");
  assertIdentifier(ref.platformCourseRef, "platformCourseRef");
  assertIdentifier(ref.stableThreadRef, "stableThreadRef");
  if (!ref.locator.trim()) {
    throw new Error("THREAD_LOCATOR_REQUIRED");
  }
  return ref;
}

export function assertTargetRef(ref: TargetRef): TargetRef {
  assertExactFields(
    ref,
    ["thread", "targetType", "targetObject", "stableTargetRef"],
    [],
    "INVALID_TARGET_REF_FIELDS"
  );
  assertThreadRef(ref.thread);
  assertIdentifier(ref.stableTargetRef, "stableTargetRef");
  if (!["thread", "comment"].includes(ref.targetType)) {
    throw new Error("INVALID_TARGET_TYPE");
  }
  if (
    !TARGET_OBJECTS.includes(
      ref.targetObject as (typeof TARGET_OBJECTS)[number]
    )
  ) {
    throw new Error("INVALID_TARGET_OBJECT");
  }
  if (
    ref.targetType === "thread" &&
    ref.stableTargetRef !== ref.thread.stableThreadRef
  ) {
    throw new Error("THREAD_TARGET_REF_MISMATCH");
  }
  return ref;
}

export function assertHash(value: string, label: string): void {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new Error(`INVALID_ADAPTER_HASH: ${label}`);
  }
}

export function assertAuthSummary(input: unknown): AuthSummary {
  const summary = assertExactFields(
    input,
    [
      "schemaVersion",
      "adapterId",
      "adapterVersion",
      "status",
      "canRead",
      "canExecuteAuthorized",
      "checkedAt",
      "evidenceHash",
      "messageCode",
      "containsForumText"
    ],
    [],
    "INVALID_AUTH_SUMMARY_FIELDS"
  );
  if (summary.schemaVersion !== AUTH_SUMMARY_SCHEMA_VERSION) {
    throw new Error("INVALID_AUTH_SUMMARY_VERSION");
  }
  assertIdentifier(summary.adapterId as string, "adapterId");
  assertIdentifier(summary.adapterVersion as string, "adapterVersion");
  if (
    ![
      "authenticated",
      "unauthenticated",
      "unknown",
      "not_applicable"
    ].includes(summary.status as string)
  ) {
    throw new Error("INVALID_AUTH_SUMMARY_STATUS");
  }
  if (
    typeof summary.canRead !== "boolean" ||
    typeof summary.canExecuteAuthorized !== "boolean"
  ) {
    throw new Error("INVALID_AUTH_SUMMARY_CAPABILITY");
  }
  assertIsoDateTime(summary.checkedAt as string, "checkedAt");
  assertHash(summary.evidenceHash as string, "evidenceHash");
  assertIdentifier(summary.messageCode as string, "messageCode");
  if (summary.containsForumText !== false) {
    throw new Error("AUTH_SUMMARY_CONTAINS_FORUM_TEXT");
  }
  return input as AuthSummary;
}

export function assertThreadPage(input: unknown): ThreadPage {
  const page = assertExactFields(
    input,
    [
      "schemaVersion",
      "adapterId",
      "adapterVersion",
      "courseKey",
      "observedAt",
      "items",
      "nextCursor",
      "containsForumText"
    ],
    [],
    "INVALID_THREAD_PAGE_FIELDS"
  );
  if (page.schemaVersion !== THREAD_PAGE_SCHEMA_VERSION) {
    throw new Error("INVALID_THREAD_PAGE_VERSION");
  }
  assertIdentifier(page.adapterId as string, "adapterId");
  assertIdentifier(page.adapterVersion as string, "adapterVersion");
  assertIdentifier(page.courseKey as string, "courseKey");
  assertIsoDateTime(page.observedAt as string, "observedAt");
  if (!Array.isArray(page.items)) {
    throw new Error("INVALID_THREAD_PAGE_ITEMS");
  }
  const stableRefs = new Set<string>();
  for (const itemInput of page.items) {
    const item = assertExactFields(
      itemInput,
      [
        "threadRef",
        "titleHash",
        "stateHintHash",
        "replyCount",
        "latestEventAt",
        "containsForumText"
      ],
      [],
      "INVALID_THREAD_SUMMARY_FIELDS"
    );
    const threadRef = assertThreadRef(item.threadRef as ThreadRef);
    if (threadRef.courseKey !== page.courseKey) {
      throw new Error("THREAD_PAGE_COURSE_MISMATCH");
    }
    if (stableRefs.has(threadRef.stableThreadRef)) {
      throw new Error("DUPLICATE_THREAD_PAGE_REF");
    }
    stableRefs.add(threadRef.stableThreadRef);
    assertHash(item.titleHash as string, "titleHash");
    assertHash(item.stateHintHash as string, "stateHintHash");
    if (
      !Number.isSafeInteger(item.replyCount) ||
      (item.replyCount as number) < 0
    ) {
      throw new Error("INVALID_THREAD_REPLY_COUNT");
    }
    if (item.latestEventAt !== null) {
      assertIsoDateTime(
        item.latestEventAt as string,
        "latestEventAt"
      );
      if (
        Date.parse(item.latestEventAt as string) >
        Date.parse(page.observedAt as string)
      ) {
        throw new Error("THREAD_PAGE_EVENT_AFTER_OBSERVATION");
      }
    }
    if (item.containsForumText !== false) {
      throw new Error("THREAD_SUMMARY_CONTAINS_FORUM_TEXT");
    }
  }
  if (
    page.nextCursor !== null &&
    (typeof page.nextCursor !== "string" ||
      page.nextCursor.trim() === "" ||
      page.nextCursor.length > 1024)
  ) {
    throw new Error("INVALID_THREAD_PAGE_CURSOR");
  }
  if (page.containsForumText !== false) {
    throw new Error("THREAD_PAGE_CONTAINS_FORUM_TEXT");
  }
  return input as ThreadPage;
}

export function assertPreflightReceipt(
  input: unknown
): PreflightReceipt {
  const receipt = assertExactFields(
    input,
    [
      "schemaVersion",
      "adapterId",
      "adapterVersion",
      "commandId",
      "status",
      "expectedTargetHash",
      "checkedAt",
      "evidenceHash",
      "messageCode",
      "containsForumText"
    ],
    [],
    "INVALID_PREFLIGHT_RECEIPT_FIELDS"
  );
  if (receipt.schemaVersion !== PREFLIGHT_RECEIPT_SCHEMA_VERSION) {
    throw new Error("INVALID_PREFLIGHT_RECEIPT_VERSION");
  }
  assertIdentifier(receipt.adapterId as string, "adapterId");
  assertIdentifier(receipt.adapterVersion as string, "adapterVersion");
  assertIdentifier(receipt.commandId as string, "commandId");
  if (
    ![
      "ready",
      "denied",
      "target_changed",
      "command_expired"
    ].includes(receipt.status as string)
  ) {
    throw new Error("INVALID_PREFLIGHT_STATUS");
  }
  assertHash(
    receipt.expectedTargetHash as string,
    "expectedTargetHash"
  );
  assertIsoDateTime(receipt.checkedAt as string, "checkedAt");
  assertHash(receipt.evidenceHash as string, "evidenceHash");
  assertIdentifier(receipt.messageCode as string, "messageCode");
  if (receipt.containsForumText !== false) {
    throw new Error("PREFLIGHT_RECEIPT_CONTAINS_FORUM_TEXT");
  }
  return input as PreflightReceipt;
}
