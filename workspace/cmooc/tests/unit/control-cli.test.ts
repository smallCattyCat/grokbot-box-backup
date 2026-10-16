import assert from "node:assert/strict";
import test from "node:test";
import { ControlApplicationService } from "../../lib/control-application-service";
import {
  parseControlCliArgs,
  runControlCli
} from "../../lib/control-cli";
import {
  CmoocApiAdapter,
  ForumAdapterRegistry
} from "../../lib/forum-adapters";

function service() {
  const registry = new ForumAdapterRegistry().register(
    new CmoocApiAdapter({
      dependencies: {
        clock: () => new Date("2026-01-01T00:00:00.000Z"),
        inspectAuth: async () => ({
          readyForRealForumWrite: false,
          sources: {
            envSatoken: { configured: false, valid: null },
            partnerAccount: { configured: false, valid: null },
            playwrightStorageState: {
              exists: false,
              hasSatoken: false,
              valid: null
            }
          }
        })
      }
    })
  );
  return new ControlApplicationService({
    registry,
    clock: () => new Date("2026-01-01T00:00:00.000Z"),
    correlationIdFactory: () => "test:cli"
  });
}

test("cmoocctl 解析 P4C-1 三个只读命令并支持 cmooc 别名", () => {
  assert.deepEqual(parseControlCliArgs(["manifest", "--json"]), {
    operation: "manifest"
  });
  assert.deepEqual(parseControlCliArgs(["status"]), {
    operation: "status"
  });
  assert.deepEqual(
    parseControlCliArgs([
      "adapter",
      "doctor",
      "--adapter",
      "cmooc"
    ]),
    {
      operation: "adapter.doctor",
      adapterId: "cmooc.api"
    }
  );
});

test("cmoocctl 拒绝发布升级参数并仍输出结构化结果", async () => {
  let output = "";
  const exitCode = await runControlCli({
    args: ["status", "--real-publish"],
    service: service(),
    write: (text) => {
      output += text;
    }
  });
  const result = JSON.parse(output) as {
    ok: boolean;
    operation: string;
    correlationId: string;
    containsForumText: boolean;
  };
  assert.equal(exitCode, 2);
  assert.equal(result.ok, false);
  assert.equal(result.operation, "invalid");
  assert.match(result.correlationId, /^cli:[a-f0-9-]{36}$/);
  assert.equal(result.containsForumText, false);
});

test("cmoocctl status 经统一 application service 返回", async () => {
  let output = "";
  const exitCode = await runControlCli({
    args: ["status"],
    service: service(),
    write: (text) => {
      output += text;
    }
  });
  const result = JSON.parse(output) as {
    ok: boolean;
    operation: string;
    capability: string;
  };
  assert.equal(exitCode, 0);
  assert.equal(result.ok, true);
  assert.equal(result.operation, "status");
  assert.equal(result.capability, "system.inspect");
});
