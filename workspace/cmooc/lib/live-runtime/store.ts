import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import {
  DRAFT_STAGING_RECEIPT_SCHEMA_VERSION,
  type DraftStagingReceipt
} from "./draft-staging";
import {
  LIVE_OPPORTUNITY_RECEIPT_SCHEMA_VERSION,
  type LiveOpportunityReceipt
} from "./facilitation-kernel";
import {
  LIVE_REVALIDATION_RECEIPT_SCHEMA_VERSION,
  type LiveRevalidationReceipt
} from "./revalidation";
import {
  DRAFT_TRANSPORT_SMOKE_RECEIPT_SCHEMA_VERSION,
  type DraftTransportSmokeReceipt
} from "./transport-smoke";

type RuntimeReceipt =
  | LiveOpportunityReceipt
  | LiveRevalidationReceipt
  | DraftStagingReceipt
  | DraftTransportSmokeReceipt;

export type RuntimeReceiptKind =
  | "opportunities"
  | "revalidations"
  | "draft-staging"
  | "transport-smoke";

function sha256(value: string, label: string): string {
  const normalized = value.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`${label}必须是 SHA-256 十六进制摘要。`);
  }
  return normalized;
}

export function liveRuntimeOutputRoot(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error("未设置 LOCALAPPDATA，无法保存真实运行回执。");
  }
  return path.resolve(
    localAppData,
    "cmooc-research",
    "live-facilitation-runtime-v1"
  );
}

function assertPersistable(receipt: RuntimeReceipt): void {
  if (
    receipt.containsForumText !== false ||
    ("realPublishEnabled" in receipt &&
      receipt.realPublishEnabled !== false) ||
    ("publishAllowed" in receipt &&
      receipt.publishAllowed !== false) ||
    ("publishAttempted" in receipt &&
      receipt.publishAttempted !== false) ||
    ("bodyPersisted" in receipt &&
      receipt.bodyPersisted !== false) ||
    ("draftBodyPersisted" in receipt &&
      receipt.draftBodyPersisted !== false)
  ) {
    throw new Error("拒绝保存含正文或越过未发布边界的运行回执。");
  }
}

const RECEIPT_SCHEMA_BY_KIND: Record<
  RuntimeReceiptKind,
  RuntimeReceipt["schemaVersion"]
> = {
  opportunities: LIVE_OPPORTUNITY_RECEIPT_SCHEMA_VERSION,
  revalidations: LIVE_REVALIDATION_RECEIPT_SCHEMA_VERSION,
  "draft-staging": DRAFT_STAGING_RECEIPT_SCHEMA_VERSION,
  "transport-smoke":
    DRAFT_TRANSPORT_SMOKE_RECEIPT_SCHEMA_VERSION
};

export async function persistRuntimeReceipt(input: {
  kind: RuntimeReceiptKind;
  receipt: RuntimeReceipt;
  receiptHash: string;
  outputRoot?: string;
}): Promise<string> {
  assertPersistable(input.receipt);
  const receiptHash = sha256(input.receiptHash, "运行回执哈希");
  if (
    input.receipt.schemaVersion !==
    RECEIPT_SCHEMA_BY_KIND[input.kind]
  ) {
    throw new Error("运行回执类型与保存目录不一致。");
  }
  const computedHash = canonicalProtocolHash(
    input.receipt.schemaVersion,
    input.receipt as unknown as CanonicalJsonValue
  );
  if (computedHash !== receiptHash) {
    throw new Error("运行回执哈希与内容不一致。");
  }
  const outputRoot = path.join(
    path.resolve(input.outputRoot ?? liveRuntimeOutputRoot()),
    input.kind
  );
  await mkdir(outputRoot, { recursive: true });
  const target = path.join(outputRoot, `${receiptHash}.json`);
  await writeFile(
    target,
    `${JSON.stringify(input.receipt, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" }
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  return target;
}

export async function loadRuntimeReceipt<T extends RuntimeReceipt>(
  kind: RuntimeReceiptKind,
  receiptHash: string,
  outputRoot = liveRuntimeOutputRoot()
): Promise<{ receipt: T; receiptHash: string }> {
  const normalizedHash = sha256(receiptHash, "运行回执哈希");
  const raw = JSON.parse(
    await readFile(
      path.join(
        path.resolve(outputRoot),
        kind,
        `${normalizedHash}.json`
      ),
      "utf8"
    )
  ) as CanonicalJsonValue;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("运行回执不是对象。");
  }
  const receipt = raw as unknown as T;
  assertPersistable(receipt);
  const computedHash = canonicalProtocolHash(
    receipt.schemaVersion,
    raw
  );
  if (computedHash !== normalizedHash) {
    throw new Error("运行回执哈希校验失败。");
  }
  return { receipt, receiptHash: normalizedHash };
}

export async function loadLatestLiveOpportunityForObservation(
  observationReceiptHash: string,
  outputRoot = liveRuntimeOutputRoot()
): Promise<{
  receipt: LiveOpportunityReceipt;
  receiptHash: string;
} | null> {
  const normalizedObservationHash = sha256(
    observationReceiptHash,
    "观察回执哈希"
  );
  const directory = path.join(
    path.resolve(outputRoot),
    "opportunities"
  );
  let names: string[];
  try {
    names = (await readdir(directory))
      .filter((name) => /^[a-f0-9]{64}\.json$/i.test(name))
      .slice(-300);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const candidates = await Promise.all(
    names.map(async (name) => {
      try {
        const loaded =
          await loadRuntimeReceipt<LiveOpportunityReceipt>(
            "opportunities",
            name.slice(0, -5),
            outputRoot
          );
        return loaded.receipt.schemaVersion ===
          LIVE_OPPORTUNITY_RECEIPT_SCHEMA_VERSION &&
          loaded.receipt.observationReceiptHash ===
            normalizedObservationHash
          ? loaded
          : null;
      } catch {
        return null;
      }
    })
  );
  return (
    candidates
      .filter(
        (
          item
        ): item is {
          receipt: LiveOpportunityReceipt;
          receiptHash: string;
        } => item !== null
      )
      .sort(
        (a, b) =>
          Date.parse(b.receipt.assessedAt) -
          Date.parse(a.receipt.assessedAt)
      )[0] ?? null
  );
}

export async function loadLatestDraftTransportSmoke(
  courseLocatorHash: string,
  outputRoot = liveRuntimeOutputRoot()
): Promise<{
  receipt: DraftTransportSmokeReceipt;
  receiptHash: string;
} | null> {
  const normalizedCourseLocatorHash = sha256(
    courseLocatorHash,
    "课程定位哈希"
  );
  const directory = path.join(
    path.resolve(outputRoot),
    "transport-smoke"
  );
  let names: string[];
  try {
    names = (await readdir(directory))
      .filter((name) => /^[a-f0-9]{64}\.json$/i.test(name))
      .slice(-300);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const candidates = await Promise.all(
    names.map(async (name) => {
      try {
        const loaded =
          await loadRuntimeReceipt<DraftTransportSmokeReceipt>(
            "transport-smoke",
            name.slice(0, -5),
            outputRoot
          );
        return loaded.receipt.schemaVersion ===
            DRAFT_TRANSPORT_SMOKE_RECEIPT_SCHEMA_VERSION &&
          loaded.receipt.courseLocatorHash ===
            normalizedCourseLocatorHash
          ? loaded
          : null;
      } catch {
        return null;
      }
    })
  );
  return (
    candidates
      .filter(
        (
          item
        ): item is {
          receipt: DraftTransportSmokeReceipt;
          receiptHash: string;
        } => item !== null
      )
      .sort(
        (a, b) =>
          Date.parse(b.receipt.observedAt) -
          Date.parse(a.receipt.observedAt)
      )[0] ?? null
  );
}
