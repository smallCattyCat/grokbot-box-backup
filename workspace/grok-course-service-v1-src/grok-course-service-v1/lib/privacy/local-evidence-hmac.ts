import {
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const LOCAL_EVIDENCE_SECRET_BYTES = 32;
const LOCAL_EVIDENCE_SECRET_FILE = "evidence-hmac-v1.key";

function runtimeSecretPath(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error(
      "未设置 LOCALAPPDATA，无法创建本机证据匿名化密钥。"
    );
  }
  return path.resolve(
    localAppData,
    "cmooc-research",
    "runtime",
    LOCAL_EVIDENCE_SECRET_FILE
  );
}

function parseSecret(value: string): Buffer {
  const normalized = value.trim();
  if (!/^[a-f0-9]{64}$/i.test(normalized)) {
    throw new Error("本机证据匿名化密钥格式无效。");
  }
  return Buffer.from(normalized, "hex");
}

export async function loadOrCreateLocalEvidenceSecret(): Promise<Buffer> {
  const secretPath = runtimeSecretPath();
  try {
    return parseSecret(await readFile(secretPath, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code && code !== "ENOENT") throw error;
  }

  await mkdir(path.dirname(secretPath), { recursive: true });
  const secret = randomBytes(LOCAL_EVIDENCE_SECRET_BYTES);
  try {
    await writeFile(secretPath, `${secret.toString("hex")}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    return secret;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    return parseSecret(await readFile(secretPath, "utf8"));
  }
}

export function localEvidenceHmac(input: {
  secret: Buffer | string;
  scope: string;
  value: string;
  length?: number;
}): string {
  const length = input.length ?? 24;
  if (!/^[a-z0-9._-]{1,80}$/i.test(input.scope)) {
    throw new Error("匿名化 scope 格式无效。");
  }
  if (!Number.isInteger(length) || length < 12 || length > 64) {
    throw new Error("匿名化摘要长度必须在 12 到 64 之间。");
  }
  return createHmac("sha256", input.secret)
    .update(`${input.scope}\0${input.value}`, "utf8")
    .digest("hex")
    .slice(0, length);
}

export function constantTimeEqualHex(
  left: string,
  right: string
): boolean {
  if (
    !/^[a-f0-9]+$/i.test(left) ||
    !/^[a-f0-9]+$/i.test(right) ||
    left.length !== right.length ||
    left.length % 2 !== 0
  ) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(left, "hex"),
    Buffer.from(right, "hex")
  );
}
