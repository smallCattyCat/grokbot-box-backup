import { randomUUID } from "node:crypto";
import {
  CAPABILITY_CATALOG,
  CAPABILITY_GATEWAY_POLICY_VERSION,
  CapabilityGateway,
  createCapabilityRequest,
  type Capability,
  type PrincipalType
} from "./capability-gateway";
import {
  ForumAdapterRegistry,
  assertAdapterManifest,
  assertAuthSummary,
  type AuthSummary
} from "./forum-adapters";
import {
  OPERATOR_REGISTRY_VERSION,
  getOperatorActionSummary
} from "./operator-registry";

export const CONTROL_RESULT_SCHEMA_VERSION =
  "cmooc.control-result.v1" as const;
export const CONTROL_MANIFEST_SCHEMA_VERSION =
  "cmooc.control-manifest.p4c1.v1" as const;

export type ControlOperation =
  | "manifest"
  | "status"
  | "adapter.doctor";

export type ControlPrincipal = {
  type: PrincipalType;
  ref: string;
};

export type ControlInvocation = {
  principal: ControlPrincipal;
  operation: ControlOperation;
  adapterId?: string;
  correlationId?: string;
};

export type ControlError = {
  code:
    | "INVALID_CONTROL_INVOCATION"
    | "CAPABILITY_DENIED"
    | "UNKNOWN_FORUM_ADAPTER"
    | "ADAPTER_DOCTOR_FAILED";
  message: string;
};

export type ControlResult = {
  schemaVersion: typeof CONTROL_RESULT_SCHEMA_VERSION;
  ok: boolean;
  correlationId: string;
  operation: ControlOperation | "invalid";
  capability: Capability | null;
  policyVersion: typeof CAPABILITY_GATEWAY_POLICY_VERSION;
  data: Record<string, unknown> | null;
  error: ControlError | null;
  containsForumText: false;
};

export type ControlApplicationServiceOptions = {
  registry: ForumAdapterRegistry;
  gateway?: CapabilityGateway;
  clock?: () => Date;
  correlationIdFactory?: () => string;
  adapterDoctorNetworkPolicy?:
    | "adapter_defined"
    | "local_metadata_only";
};

const OPERATION_CAPABILITY = {
  manifest: "system.inspect",
  status: "system.inspect",
  "adapter.doctor": "adapter.inspect_auth"
} as const satisfies Record<ControlOperation, Capability>;

const PRINCIPAL_TYPES = [
  "local_ui",
  "local_cli",
  "agent_client"
] as const satisfies readonly PrincipalType[];

const CONTROL_OPERATIONS = [
  "manifest",
  "status",
  "adapter.doctor"
] as const satisfies readonly ControlOperation[];

const IDENTIFIER_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class ControlApplicationService {
  readonly #registry: ForumAdapterRegistry;
  readonly #gateway: CapabilityGateway;
  readonly #clock: () => Date;
  readonly #correlationIdFactory: () => string;
  readonly #adapterDoctorNetworkPolicy:
    | "adapter_defined"
    | "local_metadata_only";

  constructor(options: ControlApplicationServiceOptions) {
    this.#registry = options.registry;
    this.#clock = options.clock ?? (() => new Date());
    this.#gateway =
      options.gateway ?? new CapabilityGateway({ clock: this.#clock });
    this.#correlationIdFactory =
      options.correlationIdFactory ??
      (() => `control:${randomUUID()}`);
    this.#adapterDoctorNetworkPolicy =
      options.adapterDoctorNetworkPolicy ?? "adapter_defined";
  }

  async invoke(input: unknown): Promise<ControlResult> {
    const fallbackCorrelationId = this.#correlationIdFactory();
    let invocation: ControlInvocation;
    try {
      invocation = parseControlInvocation(input);
    } catch {
      return this.#result({
        ok: false,
        correlationId: safeCorrelationId(
          input,
          fallbackCorrelationId
        ),
        operation: "invalid",
        capability: null,
        data: null,
        error: {
          code: "INVALID_CONTROL_INVOCATION",
          message: "控制请求字段、principal 或命令不符合 P4C-1 契约。"
        }
      });
    }

    const correlationId =
      invocation.correlationId ?? fallbackCorrelationId;
    const capability = OPERATION_CAPABILITY[invocation.operation];
    const decision = this.#gateway.evaluate(
      createCapabilityRequest({
        principalType: invocation.principal.type,
        principalRef: invocation.principal.ref,
        capability,
        correlationId,
        requestedAt: this.#clock().toISOString()
      })
    );
    if (decision.effect !== "allow") {
      return this.#result({
        ok: false,
        correlationId,
        operation: invocation.operation,
        capability,
        data: null,
        error: {
          code: "CAPABILITY_DENIED",
          message: `能力请求被拒绝：${decision.reasonCode}。`
        }
      });
    }

    if (invocation.operation === "manifest") {
      return this.#result({
        ok: true,
        correlationId,
        operation: invocation.operation,
        capability,
        data: this.#manifest(),
        error: null
      });
    }
    if (invocation.operation === "status") {
      return this.#result({
        ok: true,
        correlationId,
        operation: invocation.operation,
        capability,
        data: this.#status(),
        error: null
      });
    }
    return this.#adapterDoctor(
      invocation,
      correlationId,
      capability
    );
  }

  #manifest(): Record<string, unknown> {
    return {
      schemaVersion: CONTROL_MANIFEST_SCHEMA_VERSION,
      checkpoint: "P4C-1",
      supportedOperations: [...CONTROL_OPERATIONS],
      capabilities: CAPABILITY_CATALOG,
      gateway: this.#gateway.snapshot(),
      adapterRegistry: this.#registry.snapshot(),
      adapters: this.#registry.manifests(),
      operatorCompatibility: {
        contractVersion: OPERATOR_REGISTRY_VERSION,
        actionSummary: getOperatorActionSummary()
      },
      safety: {
        realPublishEnabled: false,
        externalWriteExposed: false,
        agentExternalWriteCapabilityCount: 0,
        forumTextAccepted: false
      },
      containsForumText: false
    };
  }

  #status(): Record<string, unknown> {
    return {
      checkpoint: "P4C-1",
      generatedAt: this.#clock().toISOString(),
      phases: {
        P4A: "complete",
        P4B: "complete",
        P4C: "in_progress_p4c1"
      },
      gateway: this.#gateway.snapshot(),
      adapterRegistry: this.#registry.snapshot(),
      temporalEvidenceContract: {
        decisionClock: "fixed_real_clock",
        asOfBoundary: "enforced",
        developmentYear: 2024,
        timeHoldoutYear: 2025,
        effectLanguage: "non_causal"
      },
      safety: {
        realPublishEnabled: false,
        externalWriteGrantedCount: 0,
        externalForumWriteAttempted: false
      },
      containsForumText: false
    };
  }

  async #adapterDoctor(
    invocation: ControlInvocation,
    correlationId: string,
    capability: Capability
  ): Promise<ControlResult> {
    const adapterId = invocation.adapterId!;
    let adapter;
    try {
      adapter = this.#registry.get(adapterId);
    } catch {
      return this.#result({
        ok: false,
        correlationId,
        operation: invocation.operation,
        capability,
        data: null,
        error: {
          code: "UNKNOWN_FORUM_ADAPTER",
          message: `未注册 adapter：${adapterId}。`
        }
      });
    }
    try {
      const auth: AuthSummary = assertAuthSummary(
        await adapter.inspectAuth()
      );
      return this.#result({
        ok: true,
        correlationId,
        operation: invocation.operation,
        capability,
        data: {
          adapter: assertAdapterManifest(adapter.manifest()),
          auth,
          networkPolicy: this.#adapterDoctorNetworkPolicy,
          realPublishEnabled: false,
          containsForumText: false
        },
        error: null
      });
    } catch {
      return this.#result({
        ok: false,
        correlationId,
        operation: invocation.operation,
        capability,
        data: null,
        error: {
          code: "ADAPTER_DOCTOR_FAILED",
          message: "adapter 认证摘要检查失败；未返回底层凭据或异常正文。"
        }
      });
    }
  }

  #result(
    input: Omit<
      ControlResult,
      "schemaVersion" | "policyVersion" | "containsForumText"
    >
  ): ControlResult {
    return {
      schemaVersion: CONTROL_RESULT_SCHEMA_VERSION,
      ...input,
      policyVersion: CAPABILITY_GATEWAY_POLICY_VERSION,
      containsForumText: false
    };
  }
}

function parseControlInvocation(input: unknown): ControlInvocation {
  const record = exactRecord(
    input,
    ["principal", "operation"],
    ["adapterId", "correlationId"]
  );
  const principal = exactRecord(
    record.principal,
    ["type", "ref"],
    []
  );
  if (
    !PRINCIPAL_TYPES.includes(principal.type as PrincipalType) ||
    !isIdentifier(principal.ref)
  ) {
    throw new Error("INVALID_CONTROL_PRINCIPAL");
  }
  if (
    typeof record.operation !== "string" ||
    !CONTROL_OPERATIONS.includes(record.operation as ControlOperation)
  ) {
    throw new Error("INVALID_CONTROL_OPERATION");
  }
  const operation = record.operation as ControlOperation;
  if (
    record.correlationId !== undefined &&
    !isIdentifier(record.correlationId)
  ) {
    throw new Error("INVALID_CONTROL_CORRELATION_ID");
  }
  if (operation === "adapter.doctor") {
    if (!isIdentifier(record.adapterId)) {
      throw new Error("ADAPTER_ID_REQUIRED");
    }
  } else if (record.adapterId !== undefined) {
    throw new Error("UNEXPECTED_ADAPTER_ID");
  }
  return {
    principal: {
      type: principal.type as PrincipalType,
      ref: principal.ref as string
    },
    operation,
    ...(record.adapterId === undefined
      ? {}
      : { adapterId: record.adapterId as string }),
    ...(record.correlationId === undefined
      ? {}
      : { correlationId: record.correlationId as string })
  };
}

function exactRecord(
  input: unknown,
  required: readonly string[],
  optional: readonly string[]
): Record<string, unknown> {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input)
  ) {
    throw new Error("INVALID_CONTROL_RECORD");
  }
  const record = input as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    throw new Error("INVALID_CONTROL_FIELDS");
  }
  return record;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function safeCorrelationId(
  input: unknown,
  fallback: string
): string {
  if (typeof input !== "object" || input === null) {
    return fallback;
  }
  const candidate = (input as Record<string, unknown>).correlationId;
  return isIdentifier(candidate) ? candidate : fallback;
}
