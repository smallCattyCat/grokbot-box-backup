import { loadEnvConfig } from "@next/env";
import { execFileSync } from "node:child_process";

let loaded = false;
const resolvedEnvironmentValues = new Map<string, string>();

export function defaultDatabaseUrl(nodeEnv = process.env.NODE_ENV) {
  return nodeEnv === "test" ? "file:./test.db" : "file:./dev.db";
}

export function ensureAppEnvLoaded() {
  if (loaded) return;
  // The portable service owns its environment and never imports a workstation .env.
  if (process.env.CMOOC_PORTABLE_SERVICE !== "1") loadEnvConfig(process.cwd());
  const configuredDatabaseUrl = process.env.DATABASE_URL?.trim();
  // `node --test` does not set NODE_ENV=test. Without this runner signal,
  // directly invoked database integration tests silently inherit .env and can
  // write their fixtures into dev.db. Standard runners still set NODE_ENV,
  // while this guard also protects focused one-file test commands.
  const runningNodeTest =
    typeof process.env.NODE_TEST_CONTEXT === "string" &&
    process.env.NODE_TEST_CONTEXT.length > 0;
  const isTestRuntime =
    process.env.NODE_ENV === "test" || runningNodeTest;
  const allowConfiguredTestDatabase =
    isTestRuntime &&
    process.env.CMOOC_USE_CONFIGURED_TEST_DATABASE === "1";
  process.env.DATABASE_URL =
    isTestRuntime && !allowConfiguredTestDatabase
      ? defaultDatabaseUrl("test")
      : configuredDatabaseUrl || defaultDatabaseUrl();
  loaded = true;
}

export function readEnvironmentValue(name: string): string {
  const direct = process.env[name]?.trim();
  if (direct) return direct;
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) return "";
  if (
    process.platform !== "win32" ||
    process.env.CMOOC_DISABLE_WINDOWS_ENV_FALLBACK === "1"
  ) {
    return "";
  }
  if (resolvedEnvironmentValues.has(name)) {
    return resolvedEnvironmentValues.get(name) ?? "";
  }

  let value = "";
  try {
    const script = [
      `$value=[Environment]::GetEnvironmentVariable('${name}','User')`,
      `if (-not $value) { $value=[Environment]::GetEnvironmentVariable('${name}','Machine') }`,
      "if ($value) { [Console]::Out.Write($value) }"
    ].join("; ");
    value = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000
      }
    ).trim();
  } catch {
    value = "";
  }
  resolvedEnvironmentValues.set(name, value);
  return value;
}
