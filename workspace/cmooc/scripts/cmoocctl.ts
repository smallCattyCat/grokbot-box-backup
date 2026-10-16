import fs from "node:fs/promises";
import path from "node:path";
import { CmoocApiAdapter, ForumAdapterRegistry } from "../lib/forum-adapters";
import { ControlApplicationService } from "../lib/control-application-service";
import { runControlCli } from "../lib/control-cli";

async function inspectLocalAuthConfiguration() {
  const authStatePath = path.join(
    process.cwd(),
    "playwright",
    "auth-state.json"
  );
  let authStateExists = false;
  let hasSatoken = false;
  try {
    const raw = await fs.readFile(authStatePath, "utf8");
    const state = JSON.parse(raw) as {
      cookies?: Array<{
        name?: string;
        value?: string;
        domain?: string;
      }>;
    };
    authStateExists = true;
    hasSatoken = Boolean(
      state.cookies?.some(
        (cookie) =>
          cookie.name === "Satoken" &&
          cookie.domain === "cmooc.bnu.edu.cn" &&
          cookie.value
      )
    );
  } catch {
    authStateExists = false;
    hasSatoken = false;
  }
  const partnerConfigured = Boolean(
    process.env.CMOOC_PARTNER_ACCOUNTS ||
      (
        process.env.CMOOC_PARTNER_ACCOUNT &&
        process.env.CMOOC_PARTNER_PASSWORD
      )
  );
  return {
    readyForRealForumWrite: false,
    sources: {
      envSatoken: {
        configured: Boolean(process.env.CMOOC_SATOKEN),
        valid: null
      },
      partnerAccount: {
        configured: partnerConfigured,
        valid: null
      },
      playwrightStorageState: {
        exists: authStateExists,
        hasSatoken,
        valid: null
      }
    }
  };
}

function createLocalControlService() {
  const adapter = new CmoocApiAdapter({
    dependencies: {
      inspectAuth: inspectLocalAuthConfiguration
    }
  });
  const registry = new ForumAdapterRegistry().register(adapter);
  return new ControlApplicationService({
    registry,
    adapterDoctorNetworkPolicy: "local_metadata_only"
  });
}

async function main() {
  const exitCode = await runControlCli({
    args: process.argv.slice(2),
    service: createLocalControlService(),
    write: (text) => process.stdout.write(text)
  });
  process.exitCode = exitCode;
}

void main();
