import { randomUUID } from "node:crypto";
import {
  CAPABILITIES,
  PROTOCOL_SCHEMA_VERSIONS,
  parseProtocolObject,
  type CapabilityRequestV1
} from "./facilitation-protocol";

export const CAPABILITY_GATEWAY_POLICY_VERSION =
  "cmooc.capability-policy.p4c1.v1" as const;
export const CAPABILITY_DECISION_SCHEMA_VERSION =
  "cmooc.capability-decision.v1" as const;

export type Capability = (typeof CAPABILITIES)[number];
export type CapabilityCategory =
  | "read"
  | "local_mutation"
  | "external_write";
export type PrincipalType =
  CapabilityRequestV1["principalType"];

export type CapabilityDefinition = {
  capability: Capability;
  category: CapabilityCategory;
  description: string;
};

export type CapabilityDecision = {
  schemaVersion: typeof CAPABILITY_DECISION_SCHEMA_VERSION;
  policyVersion: typeof CAPABILITY_GATEWAY_POLICY_VERSION;
  correlationId: string;
  principalType: PrincipalType | "invalid";
  principalRef: string;
  capability: string;
  category: CapabilityCategory | null;
  effect: "allow" | "deny";
  reasonCode:
    | "capability_granted"
    | "capability_not_granted"
    | "external_write_disabled"
    | "invalid_capability_request";
  evaluatedAt: string;
  containsForumText: false;
};

export const CAPABILITY_CATALOG = [
  {
    capability: "system.inspect",
    category: "read",
    description: "读取控制面、协议和适配器的脱敏状态。"
  },
  {
    capability: "adapter.inspect_auth",
    category: "read",
    description: "读取不含凭据的 adapter 认证摘要。"
  },
  {
    capability: "forum.observe",
    category: "read",
    description: "通过 adapter 读取受时点边界约束的论坛观察。"
  },
  {
    capability: "intervention.preview",
    category: "local_mutation",
    description: "在本地生成不发布的干预预演。"
  },
  {
    capability: "forum.compose_draft",
    category: "local_mutation",
    description:
      "把已重读放行的草稿写入当前页面编辑器，但不提交、不发布。"
  },
  {
    capability: "research.decision.audit",
    category: "local_mutation",
    description: "运行 P3A 决策快照只读审计并写本地审计产物。"
  },
  {
    capability: "research.scheduler.benchmark",
    category: "local_mutation",
    description: "运行离线调度 benchmark 并写本地研究产物。"
  },
  {
    capability: "review.open",
    category: "read",
    description: "打开本地人工审阅入口，不授予发布能力。"
  },
  {
    capability: "schedule.preview.configure",
    category: "local_mutation",
    description: "配置只产生本地预演的调度。"
  },
  {
    capability: "schedule.preview.run",
    category: "local_mutation",
    description: "执行一次只产生本地预演的调度。"
  },
  {
    capability: "events.read_redacted",
    category: "read",
    description: "读取不含正文和身份信息的事件。"
  },
  {
    capability: "forum.execute_authorized",
    category: "external_write",
    description: "执行已授权论坛写入；P4C-1 对所有 principal 禁用。"
  }
] as const satisfies readonly CapabilityDefinition[];

const NON_EXTERNAL_CAPABILITIES = CAPABILITY_CATALOG
  .filter((entry) => entry.category !== "external_write")
  .map((entry) => entry.capability);

const PRINCIPAL_GRANTS: Record<
  PrincipalType,
  readonly Capability[]
> = {
  local_ui: NON_EXTERNAL_CAPABILITIES,
  local_cli: NON_EXTERNAL_CAPABILITIES,
  agent_client: NON_EXTERNAL_CAPABILITIES
};

const IDENTIFIER_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type CapabilityGatewayOptions = {
  clock?: () => Date;
};

export class CapabilityGateway {
  readonly #clock: () => Date;

  constructor(options: CapabilityGatewayOptions = {}) {
    this.#clock = options.clock ?? (() => new Date());
  }

  evaluate(input: unknown): CapabilityDecision {
    const evaluatedAt = this.#clock().toISOString();
    let request: CapabilityRequestV1;
    try {
      request = parseProtocolObject("capabilityRequest", input);
    } catch {
      const candidate =
        typeof input === "object" && input !== null
          ? input as Record<string, unknown>
          : {};
      return {
        schemaVersion: CAPABILITY_DECISION_SCHEMA_VERSION,
        policyVersion: CAPABILITY_GATEWAY_POLICY_VERSION,
        correlationId: safeIdentifier(
          candidate.correlationId,
          `invalid:${randomUUID()}`
        ),
        principalType: "invalid",
        principalRef: safeIdentifier(
          candidate.principalRef,
          "invalid:principal"
        ),
        capability:
          typeof candidate.capability === "string"
            ? candidate.capability.slice(0, 128)
            : "invalid",
        category: null,
        effect: "deny",
        reasonCode: "invalid_capability_request",
        evaluatedAt,
        containsForumText: false
      };
    }

    const definition = CAPABILITY_CATALOG.find(
      (entry) => entry.capability === request.capability
    );
    if (!definition) {
      return {
        schemaVersion: CAPABILITY_DECISION_SCHEMA_VERSION,
        policyVersion: CAPABILITY_GATEWAY_POLICY_VERSION,
        correlationId: request.correlationId,
        principalType: request.principalType,
        principalRef: request.principalRef,
        capability: request.capability,
        category: null,
        effect: "deny",
        reasonCode: "capability_not_granted",
        evaluatedAt,
        containsForumText: false
      };
    }

    const granted = PRINCIPAL_GRANTS[request.principalType].includes(
      request.capability
    );
    const externalWrite = definition.category === "external_write";
    return {
      schemaVersion: CAPABILITY_DECISION_SCHEMA_VERSION,
      policyVersion: CAPABILITY_GATEWAY_POLICY_VERSION,
      correlationId: request.correlationId,
      principalType: request.principalType,
      principalRef: request.principalRef,
      capability: request.capability,
      category: definition.category,
      effect: granted && !externalWrite ? "allow" : "deny",
      reasonCode:
        granted && !externalWrite
          ? "capability_granted"
          : externalWrite
            ? "external_write_disabled"
            : "capability_not_granted",
      evaluatedAt,
      containsForumText: false
    };
  }

  snapshot() {
    const principals = (
      Object.keys(PRINCIPAL_GRANTS) as PrincipalType[]
    ).map((principalType) => {
      const grants = PRINCIPAL_GRANTS[principalType];
      return {
        principalType,
        grantedCapabilityCount: grants.length,
        externalWriteCapabilityCount: grants.filter(
          (capability) =>
            capabilityDefinition(capability).category === "external_write"
        ).length
      };
    });
    return {
      policyVersion: CAPABILITY_GATEWAY_POLICY_VERSION,
      defaultEffect: "deny" as const,
      realPublishEnabled: false as const,
      capabilityCount: CAPABILITY_CATALOG.length,
      externalWriteCapabilityCount: CAPABILITY_CATALOG.filter(
        (entry) => entry.category === "external_write"
      ).length,
      externalWriteGrantedCount: principals.reduce(
        (total, principal) =>
          total + principal.externalWriteCapabilityCount,
        0
      ),
      principals,
      containsForumText: false as const
    };
  }
}

export function createCapabilityRequest(input: {
  principalType: PrincipalType;
  principalRef: string;
  capability: Capability;
  correlationId: string;
  requestedAt: string;
  objectRefHash?: string | null;
}): CapabilityRequestV1 {
  return parseProtocolObject("capabilityRequest", {
    schemaVersion: PROTOCOL_SCHEMA_VERSIONS.capabilityRequest,
    principalType: input.principalType,
    principalRef: input.principalRef,
    capability: input.capability,
    objectRefHash: input.objectRefHash ?? null,
    correlationId: input.correlationId,
    requestedAt: input.requestedAt,
    containsForumText: false
  });
}

function capabilityDefinition(
  capability: Capability
): CapabilityDefinition {
  const definition = CAPABILITY_CATALOG.find(
    (entry) => entry.capability === capability
  );
  if (!definition) {
    throw new Error(`UNKNOWN_CAPABILITY_CATALOG_ENTRY: ${capability}`);
  }
  return definition;
}

function safeIdentifier(value: unknown, fallback: string): string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value)
    ? value
    : fallback;
}
