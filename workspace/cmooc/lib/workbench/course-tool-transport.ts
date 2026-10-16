import { createHash } from "node:crypto";
import {
  assertCourseToolJsonValue,
  assertModelSchemaHasNoServerControlledFields,
  assertSafeCourseToolProjection,
  isCourseToolName,
  isCourseToolVersion,
  parseModelToolRequest,
  sanitizeCourseToolSummary,
  type CourseToolSafeProjection,
  type ModelToolRequest
} from "@/lib/course-tools/contracts";
import type { PendingCourseAgentAction } from "@/lib/workbench/course-agent-action-coordinator";

export const WORKBENCH_COURSE_TOOL_TRANSPORT_SCHEMA_VERSION =
  "cmooc.workbench-course-tool-transport.v1" as const;

const PROTOCOL_TOOL_NAME = /^[a-z][a-z0-9_]{2,63}$/;
const MAX_TOOL_SCHEMA_BYTES = 32 * 1024;
const MAX_TOOL_DESCRIPTION_LENGTH = 320;

/**
 * A protocol-facing alias is deliberately separate from the registry name.
 * Codex receives only the function alias and business input schema; the
 * versioned registry identity remains controlled by this server boundary.
 */
export type WorkbenchCourseToolDescriptor = Readonly<{
  protocolName: string;
  toolName: string;
  toolVersion: string;
  safeLabel: string;
  safeDescription: string;
  modelInputSchema: Readonly<Record<string, unknown>>;
}>;

export type WorkbenchCourseToolInvocation = Readonly<{
  runId: string;
  callId: string;
  request: ModelToolRequest;
  signal: AbortSignal;
}>;

/**
 * The implementation is an orchestrator-owned closure. It injects task,
 * run, plan, step, course, capability, idempotency, lease and fencing data;
 * none of those fields can be supplied by Codex or a browser client.
 */
export interface WorkbenchCourseToolTransport {
  listTools(): readonly WorkbenchCourseToolDescriptor[];
  pendingInteraction?(): PendingCourseAgentAction | null;
  resolvePendingInteraction?(actionRef: string): boolean;
  invoke(
    invocation: WorkbenchCourseToolInvocation
  ): Promise<CourseToolSafeProjection>;
}

export type PreparedWorkbenchCourseToolTransport = Readonly<{
  descriptors: readonly WorkbenchCourseToolDescriptor[];
  byProtocolName: ReadonlyMap<string, WorkbenchCourseToolDescriptor>;
  dynamicToolSpecs: readonly Readonly<{
    type: "function";
    name: string;
    description: string;
    inputSchema: Readonly<Record<string, unknown>>;
    deferLoading: false;
  }>[];
}>;

export class WorkbenchCourseToolTransportError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkbenchCourseToolTransportError";
    this.code = code;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertDescriptor(
  descriptor: WorkbenchCourseToolDescriptor
): void {
  if (
    !isPlainObject(descriptor) ||
    typeof descriptor.protocolName !== "string" ||
    !PROTOCOL_TOOL_NAME.test(descriptor.protocolName) ||
    typeof descriptor.toolName !== "string" ||
    !isCourseToolName(descriptor.toolName) ||
    typeof descriptor.toolVersion !== "string" ||
    !isCourseToolVersion(descriptor.toolVersion)
  ) {
    throw new WorkbenchCourseToolTransportError(
      "WORKBENCH_COURSE_TOOL_DESCRIPTOR_INVALID",
      "Course tool descriptor identity is invalid."
    );
  }
  for (const [label, value, maxLength] of [
    ["safe label", descriptor.safeLabel, 96],
    [
      "safe description",
      descriptor.safeDescription,
      MAX_TOOL_DESCRIPTION_LENGTH
    ]
  ] as const) {
    if (
      !value.trim() ||
      value.length > maxLength ||
      sanitizeCourseToolSummary(value, maxLength) !== value
    ) {
      throw new WorkbenchCourseToolTransportError(
        "WORKBENCH_COURSE_TOOL_DESCRIPTOR_UNSAFE",
        `Course tool ${label} is not a safe protocol value.`
      );
    }
  }
  if (!isPlainObject(descriptor.modelInputSchema)) {
    throw new WorkbenchCourseToolTransportError(
      "WORKBENCH_COURSE_TOOL_SCHEMA_INVALID",
      "Course tool model input schema must be an object."
    );
  }
  assertCourseToolJsonValue(
    descriptor.modelInputSchema,
    "course tool model schema"
  );
  assertModelSchemaHasNoServerControlledFields(
    descriptor.modelInputSchema
  );
  if (
    descriptor.modelInputSchema.type !== "object" ||
    descriptor.modelInputSchema.additionalProperties !== false ||
    Buffer.byteLength(
      JSON.stringify(descriptor.modelInputSchema),
      "utf8"
    ) > MAX_TOOL_SCHEMA_BYTES
  ) {
    throw new WorkbenchCourseToolTransportError(
      "WORKBENCH_COURSE_TOOL_SCHEMA_INVALID",
      "Course tool model input schema must be closed and bounded."
    );
  }
}

export function prepareWorkbenchCourseToolTransport(
  transport: WorkbenchCourseToolTransport
): PreparedWorkbenchCourseToolTransport {
  const descriptors = transport.listTools();
  if (!Array.isArray(descriptors) || descriptors.length > 32) {
    throw new WorkbenchCourseToolTransportError(
      "WORKBENCH_COURSE_TOOL_MANIFEST_INVALID",
      "Course tool manifest is not a bounded array."
    );
  }
  const byProtocolName = new Map<
    string,
    WorkbenchCourseToolDescriptor
  >();
  const registryIdentities = new Set<string>();
  for (const descriptor of descriptors) {
    assertDescriptor(descriptor);
    const registryIdentity =
      `${descriptor.toolName}@${descriptor.toolVersion}`;
    if (
      byProtocolName.has(descriptor.protocolName) ||
      registryIdentities.has(registryIdentity)
    ) {
      throw new WorkbenchCourseToolTransportError(
        "WORKBENCH_COURSE_TOOL_MANIFEST_COLLISION",
        "Course tool manifest contains a duplicate identity."
      );
    }
    byProtocolName.set(descriptor.protocolName, descriptor);
    registryIdentities.add(registryIdentity);
  }
  const frozenDescriptors = Object.freeze([...descriptors]);
  return Object.freeze({
    descriptors: frozenDescriptors,
    byProtocolName,
    dynamicToolSpecs: Object.freeze(
      frozenDescriptors.map((descriptor) =>
        Object.freeze({
          type: "function" as const,
          name: descriptor.protocolName,
          description: descriptor.safeDescription,
          inputSchema: descriptor.modelInputSchema,
          deferLoading: false as const
        })
      )
    )
  });
}

export function parseWorkbenchCourseToolInvocation(input: {
  descriptor: WorkbenchCourseToolDescriptor;
  argumentsValue: unknown;
}): ModelToolRequest {
  return parseModelToolRequest({
    toolName: input.descriptor.toolName,
    toolVersion: input.descriptor.toolVersion,
    input: input.argumentsValue
  });
}

export function assertWorkbenchCourseToolResult(
  projection: CourseToolSafeProjection
): void {
  assertSafeCourseToolProjection(projection);
}

export function fingerprintWorkbenchCourseToolCall(input: {
  protocolName: string;
  argumentsValue: unknown;
  threadId: string;
  turnId: string;
}): string {
  assertCourseToolJsonValue(input.argumentsValue, "dynamic tool arguments");
  const payload = JSON.stringify({
    protocolName: input.protocolName,
    arguments: input.argumentsValue,
    threadId: input.threadId,
    turnId: input.turnId
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}
