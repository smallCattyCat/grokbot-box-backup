/**
 * Nutstore slim-ledger mirror helpers for mcp-bridge.
 * Authority remains Nutstore; box reads/writes only the local slim mirror.
 * MCP tape writes go to DecisionTapeEntry only (hash-chained; requires a real
 * ScheduledInvocation id). AgentPatrolLedger is deprecated read-compat.
 * ScheduledInvocation rows are created only via patrol_begin (slim lease claim).
 *
 * Prefers python3 + sqlite3 via CMOOC_LEDGER_DB (no native better-sqlite3).
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const MIRROR_DIR = "/workspace/cmooc-ledger-mirror";
export const MIRROR_SLIM_DB = path.join(MIRROR_DIR, "ledger-slim.db");
export const MIRROR_FULL_DB = path.join(MIRROR_DIR, "dev.db");
export const MIRROR_ACTIVE_MARKER = path.join(MIRROR_DIR, ".use-mirror");
export const DEFAULT_MIRROR_URL = `file:${MIRROR_SLIM_DB}`;
export const DEFAULT_LEDGER_DB = MIRROR_SLIM_DB;

export const EXPECTED_SLIM_BYTES_MIN = 10_000_000;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PYTHON_OPS = path.join(HERE, "ledger_slim_ops.py");

function fileStat(p: string): {
  exists: boolean;
  size: number | null;
  mtime: string | null;
} {
  try {
    const st = fs.statSync(p);
    return {
      exists: true,
      size: st.size,
      mtime: st.mtime.toISOString()
    };
  } catch {
    return { exists: false, size: null, mtime: null };
  }
}

/** Resolve local slim DB path from CMOOC_LEDGER_DB (preferred) or mirror defaults. */
export function resolveLedgerDbPath(): string {
  const explicit = process.env.CMOOC_LEDGER_DB?.trim();
  if (explicit) return explicit;
  for (const key of ["CMOOC_DATABASE_URL", "DATABASE_URL"] as const) {
    const raw = process.env[key]?.trim();
    if (!raw) continue;
    if (raw.startsWith("file:")) return raw.slice(5);
    if (!/^(postgres|mysql|sqlserver)/i.test(raw)) return raw;
  }
  if (fs.existsSync(MIRROR_SLIM_DB)) return MIRROR_SLIM_DB;
  return DEFAULT_LEDGER_DB;
}

export function resolveMirrorDatabaseUrl(): string | null {
  const explicit = process.env.CMOOC_DATABASE_URL?.trim();
  if (explicit) return explicit;
  if (fs.existsSync(MIRROR_ACTIVE_MARKER)) {
    if (fs.existsSync(MIRROR_SLIM_DB)) return DEFAULT_MIRROR_URL;
    if (fs.existsSync(MIRROR_FULL_DB)) return `file:${MIRROR_FULL_DB}`;
  }
  const db = resolveLedgerDbPath();
  if (fs.existsSync(db)) return `file:${db}`;
  return null;
}

/** Call before ensureAppEnvLoaded so DATABASE_URL sticks for prisma ops. */
export function applyMirrorDatabaseEnv(): {
  applied: boolean;
  databaseUrl: string | null;
  ledgerDb: string;
} {
  const ledgerDb = resolveLedgerDbPath();
  if (!process.env.CMOOC_LEDGER_DB) process.env.CMOOC_LEDGER_DB = ledgerDb;
  const url = resolveMirrorDatabaseUrl();
  if (!url) return { applied: false, databaseUrl: null, ledgerDb };
  process.env.CMOOC_DATABASE_URL = url;
  process.env.DATABASE_URL = url;
  return { applied: true, databaseUrl: url, ledgerDb };
}

function runPythonOp(
  op: string,
  flagArgs: string[] = []
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const db = resolveLedgerDbPath();
    const env = {
      ...process.env,
      CMOOC_LEDGER_DB: db
    };
    const child = spawn(
      "python3",
      [PYTHON_OPS, op, "--db", db, ...flagArgs],
      {
        env,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const trimmed = stdout.trim();
      if (!trimmed) {
        reject(
          new Error(
            `ledger_slim_ops.py produced no stdout (exit ${code}): ${stderr.trim() || "(no stderr)"}`
          )
        );
        return;
      }
      const lines = trimmed.split(/\r?\n/).filter(Boolean);
      let parsed: Record<string, unknown> | null = null;
      let parseErr: unknown = null;
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          parsed = JSON.parse(lines[i]) as Record<string, unknown>;
          parseErr = null;
          break;
        } catch (err) {
          parseErr = err;
        }
      }
      if (!parsed) {
        reject(
          new Error(
            `ledger_slim_ops.py stdout not JSON (exit ${code}): ${
              parseErr instanceof Error ? parseErr.message : String(parseErr)
            }\n${trimmed.slice(0, 1500)}`
          )
        );
        return;
      }
      resolve(parsed);
    });
  });
}

export async function ledgerSyncStatus(_opts: { expectedBytes?: number } = {}) {
  await fsp.mkdir(MIRROR_DIR, { recursive: true });
  return runPythonOp("sync_status");
}

export async function ledgerUseMirror(opts: {
  source?: string;
  preferFull?: boolean;
}) {
  await fsp.mkdir(MIRROR_DIR, { recursive: true });

  if (opts.source) {
    const src = path.resolve(opts.source);
    if (!fs.existsSync(src)) {
      return {
        ok: false,
        error: {
          code: "SOURCE_MISSING",
          message: `Local source not found on box: ${src}`
        },
        externalMutationAttempted: false,
        containsForumText: false
      };
    }
    const destName = path.basename(src).toLowerCase().includes("slim")
      ? MIRROR_SLIM_DB
      : opts.preferFull
        ? MIRROR_FULL_DB
        : MIRROR_SLIM_DB;
    await fsp.copyFile(src, destName);
  }

  const target =
    opts.preferFull && fs.existsSync(MIRROR_FULL_DB)
      ? MIRROR_FULL_DB
      : fs.existsSync(MIRROR_SLIM_DB)
        ? MIRROR_SLIM_DB
        : fs.existsSync(MIRROR_FULL_DB)
          ? MIRROR_FULL_DB
          : null;

  if (!target) {
    return {
      ok: false,
      error: {
        code: "MIRROR_MISSING",
        message:
          "No mirror DB at ledger-slim.db or dev.db. Bot must CopyToBox slim export first.",
        mirrorDir: MIRROR_DIR
      },
      externalMutationAttempted: false,
      containsForumText: false
    };
  }

  const url = `file:${target}`;
  process.env.CMOOC_LEDGER_DB = target;
  process.env.CMOOC_DATABASE_URL = url;
  process.env.DATABASE_URL = url;
  await fsp.writeFile(
    MIRROR_ACTIVE_MARKER,
    `${url}\nupdatedAt=${new Date().toISOString()}\n`,
    "utf8"
  );

  const st = fileStat(target);
  return {
    ok: true,
    databaseUrl: url,
    path: target,
    size: st.size,
    mtime: st.mtime,
    env: {
      CMOOC_LEDGER_DB: target,
      CMOOC_DATABASE_URL: url,
      note: "Subsequent mcp-bridge / MCP child processes should inherit CMOOC_LEDGER_DB"
    },
    externalMutationAttempted: false,
    containsForumText: false
  };
}

export async function tapeGetByPost(opts: {
  forumPostId: string;
  limit?: number;
}) {
  const args = ["--forumPostId", opts.forumPostId.trim()];
  if (opts.limit != null) args.push("--limit", String(opts.limit));
  return runPythonOp("get_by_post", args);
}

export async function tapeAppend(opts: {
  invocationId: string;
  forumPostId?: string;
  kind: string;
  decision?: string;
  reasonCode?: string;
  status?: string;
  payload?: Record<string, unknown>;
}) {
  const args = [
    "--invocationId",
    opts.invocationId.trim(),
    "--kind",
    opts.kind.trim()
  ];
  if (opts.forumPostId) args.push("--forumPostId", opts.forumPostId.trim());
  if (opts.decision) args.push("--decision", opts.decision.trim());
  if (opts.reasonCode) args.push("--reasonCode", opts.reasonCode.trim());
  if (opts.status) args.push("--status", opts.status);
  if (opts.payload) args.push("--payload", JSON.stringify(opts.payload));
  return runPythonOp("append", args);
}

export async function patrolBegin(opts: {
  courseAlias: string;
  leaseSeconds?: number;
}) {
  const args = ["--courseAlias", opts.courseAlias.trim()];
  if (opts.leaseSeconds != null) {
    args.push("--leaseSeconds", String(opts.leaseSeconds));
  }
  return runPythonOp("patrol_begin", args);
}

export async function patrolEnd(opts: {
  invocationId: string;
  leaseOwner?: string;
}) {
  const args = ["--invocationId", opts.invocationId.trim()];
  if (opts.leaseOwner) args.push("--leaseOwner", opts.leaseOwner.trim());
  return runPythonOp("patrol_end", args);
}

