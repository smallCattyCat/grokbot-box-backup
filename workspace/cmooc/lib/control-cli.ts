import { randomUUID } from "node:crypto";
import {
  CONTROL_RESULT_SCHEMA_VERSION,
  type ControlApplicationService,
  type ControlInvocation,
  type ControlOperation,
  type ControlResult
} from "./control-application-service";
import { CAPABILITY_GATEWAY_POLICY_VERSION } from "./capability-gateway";

export type ParsedControlCliCommand = Pick<
  ControlInvocation,
  "operation" | "adapterId"
>;

export function parseControlCliArgs(
  args: readonly string[]
): ParsedControlCliCommand {
  const normalized = args.filter((arg) => arg !== "--json");
  if (normalized.length === 1 && normalized[0] === "manifest") {
    return { operation: "manifest" };
  }
  if (normalized.length === 1 && normalized[0] === "status") {
    return { operation: "status" };
  }
  if (
    normalized.length === 4 &&
    normalized[0] === "adapter" &&
    normalized[1] === "doctor" &&
    normalized[2] === "--adapter" &&
    normalized[3]
  ) {
    return {
      operation: "adapter.doctor",
      adapterId:
        normalized[3] === "cmooc"
          ? "cmooc.api"
          : normalized[3]
    };
  }
  throw new Error("UNSUPPORTED_CMOOCCTL_COMMAND");
}

export async function runControlCli(input: {
  args: readonly string[];
  service: ControlApplicationService;
  write: (text: string) => void;
  principalRef?: string;
}): Promise<number> {
  let command: ParsedControlCliCommand;
  try {
    command = parseControlCliArgs(input.args);
  } catch {
    const result: ControlResult = {
      schemaVersion: CONTROL_RESULT_SCHEMA_VERSION,
      ok: false,
      correlationId: `cli:${randomUUID()}`,
      operation: "invalid",
      capability: null,
      policyVersion: CAPABILITY_GATEWAY_POLICY_VERSION,
      data: {
        supportedCommands: [
          "manifest --json",
          "status",
          "adapter doctor --adapter <adapter-id>"
        ]
      },
      error: {
        code: "INVALID_CONTROL_INVOCATION",
        message: "不支持的 cmoocctl 命令或参数。"
      },
      containsForumText: false
    };
    input.write(`${JSON.stringify(result, null, 2)}\n`);
    return 2;
  }

  const result = await input.service.invoke({
    principal: {
      type: "local_cli",
      ref: input.principalRef ?? "cmoocctl.local"
    },
    operation: command.operation as ControlOperation,
    ...(command.adapterId === undefined
      ? {}
      : { adapterId: command.adapterId })
  });
  input.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok ? 0 : 1;
}
