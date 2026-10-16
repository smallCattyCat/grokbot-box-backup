import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  lstat,
  rename,
  unlink,
} from "node:fs/promises";
import {
  readFileSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  resolvePortableServiceDataDir,
  type PortableCourseClientSession,
} from "./portable-course-client";

/**
 * The MCP connector has a private, durable session area.  It is deliberately
 * separate from the CLI session area: a Grok connector may be restarted while
 * a CLI caller is using the same service data root.
 */
export const PORTABLE_MCP_SESSION_SCHEMA_VERSION = "cmooc.portable-mcp-session.v1" as const;

const sessionNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const ownerSchema = z.string().uuid();
const leasesSchema = z.record(z.string().uuid(), z.string().min(1));
const sessionSchema = z.object({ owner: ownerSchema, leases: leasesSchema }).strict();
const storedSessionSchema = z.object({
  schemaVersion: z.literal(PORTABLE_MCP_SESSION_SCHEMA_VERSION),
  sessionName: sessionNameSchema,
  owner: ownerSchema,
  leases: leasesSchema,
}).strict();
const lockSchema = z.object({
  pid: z.number().int().positive(),
  nonce: z.string().uuid(),
  sessionName: sessionNameSchema,
}).strict();

export type PortableMcpSessionOptions = {
  dataDir?: string;
  sessionName?: string;
};

export type PortableMcpSessionHandle = {
  readonly sessionName: string;
  readonly sessionPath: string;
  readonly lockPath: string;
  readonly session: PortableCourseClientSession;
  /** Save only owner/lease state; bridge keys and other credentials never enter this file. */
  save(session: PortableCourseClientSession): Promise<void>;
  /** Release this process' lock if it still owns it. */
  release(): Promise<void>;
  /** Best-effort synchronous release for process exit and fatal signals. */
  releaseSync(): void;
};

export class PortableMcpSessionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PortableMcpSessionError";
  }
}

export function resolvePortableMcpSessionName(value?: string): string {
  const candidate = value ?? process.env.CMOOC_MCP_SESSION ?? "default";
  const parsed = sessionNameSchema.safeParse(candidate);
  if (!parsed.success) throw new PortableMcpSessionError("MCP_SESSION_INVALID", "MCP 会话名无效。");
  return parsed.data;
}

export function resolvePortableMcpSessionDirectory(dataDir?: string): string {
  return path.join(resolvePortableServiceDataDir(dataDir), "mcp-sessions");
}

function safeSessionPath(directory: string, sessionName: string): string {
  const resolvedDirectory = path.resolve(directory);
  const candidate = path.resolve(resolvedDirectory, `${sessionName}.json`);
  if (path.dirname(candidate) !== resolvedDirectory) throw new PortableMcpSessionError("MCP_SESSION_PATH_INVALID", "MCP 会话路径无效。");
  return candidate;
}

function safeLockPath(directory: string, sessionName: string): string {
  const resolvedDirectory = path.resolve(directory);
  const candidate = path.resolve(resolvedDirectory, `${sessionName}.lock`);
  if (path.dirname(candidate) !== resolvedDirectory) throw new PortableMcpSessionError("MCP_SESSION_LOCK_PATH_INVALID", "MCP 会话锁路径无效。");
  return candidate;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory).catch(() => null);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new PortableMcpSessionError("MCP_SESSION_DIRECTORY_INVALID", "MCP 会话目录无效。");
  if (process.platform !== "win32") await chmod(directory, 0o700).catch(() => undefined);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    return true;
  }
}

async function reclaimStaleLock(lockPath: string): Promise<void> {
  const stat = await lstat(lockPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw new PortableMcpSessionError("MCP_SESSION_LOCK_UNREADABLE", "MCP 会话锁不可读。");
  });
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new PortableMcpSessionError("MCP_SESSION_LOCK_INVALID", "MCP 会话锁无效。");
  let parsed: z.infer<typeof lockSchema>;
  try {
    parsed = lockSchema.parse(JSON.parse(await readFile(lockPath, "utf8")));
  } catch {
    throw new PortableMcpSessionError("MCP_SESSION_LOCK_INVALID", "MCP 会话锁无效。");
  }
  if (processIsAlive(parsed.pid)) throw new PortableMcpSessionError("MCP_SESSION_BUSY", "同名 MCP 会话正在运行。");
  await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw new PortableMcpSessionError("MCP_SESSION_LOCK_RELEASE_FAILED", "无法回收失效的 MCP 会话锁。");
  });
}

async function acquireSessionLock(directory: string, sessionName: string): Promise<{ lockPath: string; nonce: string }> {
  const lockPath = safeLockPath(directory, sessionName);
  const nonce = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, nonce, sessionName }));
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { lockPath, nonce };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new PortableMcpSessionError("MCP_SESSION_LOCK_FAILED", "无法创建 MCP 会话锁。");
      await reclaimStaleLock(lockPath);
    }
  }
  throw new PortableMcpSessionError("MCP_SESSION_BUSY", "同名 MCP 会话正在运行。");
}

async function readStoredSession(sessionPath: string, sessionName: string): Promise<PortableCourseClientSession> {
  const stat = await lstat(sessionPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw new PortableMcpSessionError("MCP_SESSION_UNREADABLE", "MCP 会话状态不可读。");
  });
  if (!stat) return { owner: randomUUID(), leases: {} };
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_000_000) throw new PortableMcpSessionError("MCP_SESSION_FILE_INVALID", "MCP 会话状态无效。");
  try {
    const parsed = storedSessionSchema.parse(JSON.parse(await readFile(sessionPath, "utf8")));
    if (parsed.sessionName !== sessionName) throw new Error("session name mismatch");
    return sessionSchema.parse({ owner: parsed.owner, leases: parsed.leases });
  } catch {
    throw new PortableMcpSessionError("MCP_SESSION_FILE_INVALID", "MCP 会话状态无效。");
  }
}

async function persistSession(sessionPath: string, sessionName: string, session: PortableCourseClientSession): Promise<void> {
  const parsed = sessionSchema.safeParse(session);
  if (!parsed.success) throw new PortableMcpSessionError("MCP_SESSION_STATE_INVALID", "MCP 会话状态无效。");
  const temporary = `${sessionPath}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify({
      schemaVersion: PORTABLE_MCP_SESSION_SCHEMA_VERSION,
      sessionName,
      owner: parsed.data.owner,
      leases: parsed.data.leases,
    }));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, sessionPath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw new PortableMcpSessionError("MCP_SESSION_SAVE_FAILED", "无法保存 MCP 会话状态。");
  }
  if (process.platform !== "win32") await chmod(sessionPath, 0o600).catch(() => undefined);
}

export async function openPortableMcpSession(options: PortableMcpSessionOptions = {}): Promise<PortableMcpSessionHandle> {
  const sessionName = resolvePortableMcpSessionName(options.sessionName);
  const directory = resolvePortableMcpSessionDirectory(options.dataDir);
  await ensurePrivateDirectory(directory);
  const { lockPath, nonce } = await acquireSessionLock(directory, sessionName);
  const sessionPath = safeSessionPath(directory, sessionName);
  try {
    const session = await readStoredSession(sessionPath, sessionName);
    await persistSession(sessionPath, sessionName, session);
    let released = false;
    let writeChain: Promise<void> = Promise.resolve();
    const releaseSync = (): void => {
      if (released) return;
      released = true;
      try {
        const raw = readFileSync(lockPath, "utf8");
        const saved = lockSchema.safeParse(JSON.parse(raw));
        if (saved.success && saved.data.nonce === nonce) unlinkSync(lockPath);
      } catch {
        // Process exit cleanup must never print or throw. A later connector
        // startup can reclaim the lock after checking its PID.
      }
    };
    return {
      sessionName,
      sessionPath,
      lockPath,
      session,
      save: async (nextSession) => {
        if (released) throw new PortableMcpSessionError("MCP_SESSION_RELEASED", "MCP 会话已释放。");
        const pending = writeChain.catch(() => undefined).then(async () => {
          await persistSession(sessionPath, sessionName, nextSession);
          Object.assign(session, { owner: nextSession.owner, leases: { ...nextSession.leases } });
        });
        writeChain = pending;
        await pending;
      },
      release: async () => {
        if (released) return;
        await writeChain.catch(() => undefined);
        released = true;
        const raw = await readFile(lockPath, "utf8").catch(() => "");
        const saved = (() => {
          try { return lockSchema.safeParse(JSON.parse(raw)); } catch { return { success: false } as const; }
        })();
        if (saved.success && saved.data.nonce === nonce) await unlink(lockPath).catch(() => undefined);
      },
      releaseSync,
    };
  } catch (error) {
    try {
      const raw = await readFile(lockPath, "utf8").catch(() => "");
      const saved = (() => {
        try { return lockSchema.safeParse(JSON.parse(raw)); } catch { return { success: false } as const; }
      })();
      if (saved.success && saved.data.nonce === nonce) await unlink(lockPath).catch(() => undefined);
    } catch {
      // Preserve the stable session error rather than exposing filesystem data.
    }
    throw error;
  }
}
