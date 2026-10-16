import {
  mkdir,
  readFile,
  readdir,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";
import { decideReadOnlyPlaywrightRequest } from "@/lib/forum-adapters/cmooc-playwright-read-only-probe";
import {
  normalizeCmoocCourseTargetInput,
  type ForumTargetNormalizationSource
} from "@/lib/forum/normalize-target-input";
import {
  constantTimeEqualHex,
  loadOrCreateLocalEvidenceSecret,
  localEvidenceHmac
} from "@/lib/privacy/local-evidence-hmac";

export const CMOOC_UI_READINESS_SCHEMA_VERSION =
  "cmooc.ui-readiness-receipt.v1" as const;

export type CmoocUiReadinessStatus =
  | "overview_ready"
  | "shell_only"
  | "blocked";

export type CmoocDetailObservation =
  | "detail_observed"
  | "not_available_public_session"
  | "not_attempted_read_only_boundary"
  | "interaction_no_transition"
  | "interaction_failed"
  | "no_cards";

export type CmoocApiAssistKind =
  | "auth_check"
  | "course_columns"
  | "sketch_page"
  | "sketch_detail"
  | "comment_list";

export type CmoocDetailEvidenceLevel =
  | "none"
  | "ui_selected_api_correlated"
  | "ui_detail_observed";

export type CmoocUiReadinessObservation = {
  finalUrl: string;
  browserRuntime: "playwright_chromium" | "system_chrome";
  courseShellDetected: boolean;
  categoryTabCount: number;
  visibleCardCount: number;
  publicLoginControlDetected: boolean;
  detailObservation: CmoocDetailObservation;
  allowedGetOrHeadCount: number;
  allowedSemanticReadPostCount: number;
  blockedWriteRequestCount: number;
  blockedCrossOriginRequestCount: number;
  apiAssistKinds: CmoocApiAssistKind[];
  visibleCardKeys: string[];
  selectedThreadKey: string | null;
  detailEvidenceLevel: CmoocDetailEvidenceLevel;
};

export type CmoocUiReadinessReceipt = {
  schemaVersion: typeof CMOOC_UI_READINESS_SCHEMA_VERSION;
  observedAt: string;
  transport: "ui_native_browser";
  targetOrigin: string;
  targetPath: "/cMOOC/course";
  targetLocatorHash: string;
  normalizationSource: ForumTargetNormalizationSource;
  inputWasNormalized: boolean;
  browserRuntime:
    | "playwright_chromium"
    | "system_chrome";
  status: CmoocUiReadinessStatus;
  safeToDemonstrate: boolean;
  courseShellDetected: boolean;
  categoryTabCount: number;
  visibleCardCount: number;
  visibleCardKeys: string[];
  selectedThreadKey: string | null;
  detailEvidenceLevel: CmoocDetailEvidenceLevel;
  sessionBoundary:
    | "public_unauthenticated"
    | "authenticated_or_unknown";
  detailObservation: CmoocDetailObservation;
  apiAssistKinds: CmoocApiAssistKind[];
  allowedGetOrHeadCount: number;
  allowedSemanticReadPostCount: number;
  blockedWriteRequestCount: number;
  blockedCrossOriginRequestCount: number;
  requestedMutationCount: number;
  sentMutationCount: 0;
  networkGuardActive: true;
  requestPolicy: "READ_ONLY_ENDPOINT_ALLOWLIST";
  realPublishEnabled: false;
  externalWriteAttempted: false;
  containsForumText: false;
};

export type CmoocUiReadinessResult = {
  canonicalUrl: string;
  receipt: CmoocUiReadinessReceipt;
  evidenceHash: string;
  receiptPath: string;
};

function readinessStatus(
  observation: CmoocUiReadinessObservation
): CmoocUiReadinessStatus {
  if (
    observation.courseShellDetected &&
    observation.categoryTabCount > 0 &&
    observation.visibleCardCount > 0
  ) {
    return "overview_ready";
  }
  return observation.courseShellDetected ? "shell_only" : "blocked";
}

function uniqueApiKinds(
  values: readonly CmoocApiAssistKind[]
): CmoocApiAssistKind[] {
  return [...new Set(values)].sort();
}

export function createCmoocUiReadinessReceipt(input: {
  canonicalUrl: string;
  normalizationSource: ForumTargetNormalizationSource;
  inputWasNormalized: boolean;
  observedAt: string;
  observation: CmoocUiReadinessObservation;
}): {
  receipt: CmoocUiReadinessReceipt;
  evidenceHash: string;
} {
  const target = new URL(input.canonicalUrl);
  const finalUrl = new URL(input.observation.finalUrl);
  const targetCourseId = target.searchParams.get("courseId");
  const finalCourseId = finalUrl.searchParams.get("courseId");
  if (
    target.origin !== finalUrl.origin ||
    !/^\/cMOOC\/course\/?$/i.test(finalUrl.pathname) ||
    !targetCourseId ||
    targetCourseId !== finalCourseId
  ) {
    throw new Error("真实界面导航结果与已核验课程目标不一致。");
  }
  if (!Number.isFinite(Date.parse(input.observedAt))) {
    throw new Error("observedAt 必须是有效时间。");
  }
  const status = readinessStatus(input.observation);
  const visibleCardKeys = [
    ...new Set(input.observation.visibleCardKeys)
  ].slice(0, input.observation.visibleCardCount);
  if (
    visibleCardKeys.some((value) => !/^[a-f0-9]{24}$/i.test(value)) ||
    (input.observation.selectedThreadKey !== null &&
      !/^[a-f0-9]{24}$/i.test(
        input.observation.selectedThreadKey
      ))
  ) {
    throw new Error("真实界面匿名卡片键格式无效。");
  }
  const receipt: CmoocUiReadinessReceipt = {
    schemaVersion: CMOOC_UI_READINESS_SCHEMA_VERSION,
    observedAt: new Date(input.observedAt).toISOString(),
    transport: "ui_native_browser",
    targetOrigin: target.origin,
    targetPath: "/cMOOC/course",
    targetLocatorHash: canonicalProtocolHash(
      "cmooc.ui-target-locator.v1",
      input.canonicalUrl
    ),
    normalizationSource: input.normalizationSource,
    inputWasNormalized: input.inputWasNormalized,
    browserRuntime: input.observation.browserRuntime,
    status,
    safeToDemonstrate: status === "overview_ready",
    courseShellDetected: input.observation.courseShellDetected,
    categoryTabCount: input.observation.categoryTabCount,
    visibleCardCount: input.observation.visibleCardCount,
    visibleCardKeys,
    selectedThreadKey: input.observation.selectedThreadKey,
    detailEvidenceLevel: input.observation.detailEvidenceLevel,
    sessionBoundary: input.observation.publicLoginControlDetected
      ? "public_unauthenticated"
      : "authenticated_or_unknown",
    detailObservation: input.observation.detailObservation,
    apiAssistKinds: uniqueApiKinds(
      input.observation.apiAssistKinds
    ),
    allowedGetOrHeadCount:
      input.observation.allowedGetOrHeadCount,
    allowedSemanticReadPostCount:
      input.observation.allowedSemanticReadPostCount,
    blockedWriteRequestCount:
      input.observation.blockedWriteRequestCount,
    blockedCrossOriginRequestCount:
      input.observation.blockedCrossOriginRequestCount,
    requestedMutationCount:
      input.observation.blockedWriteRequestCount,
    sentMutationCount: 0,
    networkGuardActive: true,
    requestPolicy: "READ_ONLY_ENDPOINT_ALLOWLIST",
    realPublishEnabled: false,
    externalWriteAttempted: false,
    containsForumText: false
  };
  return {
    receipt,
    evidenceHash: canonicalProtocolHash(
      receipt.schemaVersion,
      receipt as CanonicalJsonValue
    )
  };
}

function apiAssistKind(url: URL): CmoocApiAssistKind | null {
  if (/\/login\/checkTokenValid\/?$/i.test(url.pathname)) {
    return "auth_check";
  }
  if (/\/course\/columns\//i.test(url.pathname)) {
    return "course_columns";
  }
  if (/\/sketch\/page\/?$/i.test(url.pathname)) {
    return "sketch_page";
  }
  if (/\/sketch\/detail\//i.test(url.pathname)) {
    return "sketch_detail";
  }
  if (/\/comment\/list\/?$/i.test(url.pathname)) {
    return "comment_list";
  }
  return null;
}

export function isAllowedCmoocSemanticReadPost(input: {
  url: string;
  method: string;
  targetOrigin: string;
}): boolean {
  if (input.method.toUpperCase() !== "POST") return false;
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return false;
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== input.targetOrigin ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return false;
  }
  for (const key of url.searchParams.keys()) {
    const normalizedKey = key.toLowerCase().replace(/[-_]/g, "");
    if (
      [
        "token",
        "auth",
        "authorization",
        "cookie",
        "session",
        "password",
        "secret",
        "credential",
        "jwt"
      ].some((marker) => normalizedKey.includes(marker))
    ) {
      return false;
    }
  }
  return [
    /^\/(?:cmooc-api\/)?login\/checkTokenValid\/?$/i,
    /^\/(?:cmooc-api\/)?sketch\/page\/?$/i
  ].some((pattern) => pattern.test(url.pathname));
}

async function launchBrowser(): Promise<{
  browser: Browser;
  runtime: CmoocUiReadinessObservation["browserRuntime"];
}> {
  try {
    return {
      browser: await chromium.launch({ headless: true }),
      runtime: "playwright_chromium"
    };
  } catch {
    return {
      browser: await chromium.launch({
        channel: "chrome",
        headless: true
      }),
      runtime: "system_chrome"
    };
  }
}

type TransientCardLocatorSeed = {
  stableRef: string | null;
  position: number;
};

async function createVisibleCardKeys(input: {
  page: Page;
  courseId: string;
  secret: Buffer;
}): Promise<string[]> {
  const seeds = await input.page
    .locator("#cSketch .card")
    .evaluateAll((cards): TransientCardLocatorSeed[] =>
      cards.slice(0, 40).map((card, position) => {
        const stableAttributeNames = [
          "data-id",
          "data-key",
          "data-module-id",
          "data-sketch-id",
          "data-post-id"
        ];
        const stableRef =
          stableAttributeNames
            .map((name) => card.getAttribute(name))
            .find((value) => Boolean(value?.trim())) ??
          card.querySelector("a[href]")?.getAttribute("href") ??
          null;
        return {
          stableRef: stableRef?.trim() || null,
          position
        };
      })
    );

  return seeds.map((seed) =>
    localEvidenceHmac({
      secret: input.secret,
      scope: "visible-card-v1",
      value: [
        input.courseId,
        seed.stableRef
          ? `stable:${seed.stableRef}`
          : `visible-position:${seed.position}`
      ].join("\0")
    })
  );
}

function detailObservationWithinReadOnlyBoundary(
  visibleCardCount: number
): CmoocDetailObservation {
  if (visibleCardCount === 0) return "no_cards";
  return "not_attempted_read_only_boundary";
}

async function observeCourseInterface(input: {
  canonicalUrl: string;
  timeoutMs: number;
}): Promise<CmoocUiReadinessObservation> {
  const target = new URL(input.canonicalUrl);
  const courseId = target.searchParams.get("courseId");
  if (!courseId) {
    throw new Error("真实课程目标缺少 courseId。");
  }
  const evidenceSecret = await loadOrCreateLocalEvidenceSecret();
  const { browser, runtime } = await launchBrowser();
  const apiKinds = new Set<CmoocApiAssistKind>();
  let allowedGetOrHeadCount = 0;
  let allowedSemanticReadPostCount = 0;
  let blockedWriteRequestCount = 0;
  let blockedCrossOriginRequestCount = 0;

  try {
    const context = await browser.newContext({
      serviceWorkers: "block",
      acceptDownloads: false,
      viewport: { width: 1440, height: 1000 }
    });
    await context.route("**/*", async (route, request) => {
      const decision = decideReadOnlyPlaywrightRequest({
        url: request.url(),
        method: request.method(),
        allowedOrigins: [target.origin]
      });
      if (decision.action === "allow") {
        allowedGetOrHeadCount += 1;
        const parsed = new URL(request.url());
        const kind = apiAssistKind(parsed);
        if (kind) apiKinds.add(kind);
        await route.continue();
        return;
      }
      if (
        decision.code === "method_not_allowed" &&
        isAllowedCmoocSemanticReadPost({
          url: request.url(),
          method: request.method(),
          targetOrigin: target.origin
        })
      ) {
        allowedSemanticReadPostCount += 1;
        const parsed = new URL(request.url());
        const kind = apiAssistKind(parsed);
        if (kind) apiKinds.add(kind);
        await route.continue();
        return;
      }
      if (decision.code === "method_not_allowed") {
        blockedWriteRequestCount += 1;
      } else if (decision.code === "origin_not_allowed") {
        blockedCrossOriginRequestCount += 1;
      }
      await route.abort("blockedbyclient");
    });
    await context.routeWebSocket(/.*/, (route) =>
      route.close({
        code: 1008,
        reason: "LIFT-1 read-only interface probe"
      })
    );
    const page = await context.newPage();
    page.on("download", (download) => {
      void download.cancel();
    });
    page.on("dialog", (dialog) => {
      void dialog.dismiss();
    });
    await page.goto(input.canonicalUrl, {
      waitUntil: "domcontentloaded",
      timeout: input.timeoutMs
    });
    await page
      .locator("#cCourse")
      .waitFor({ state: "attached", timeout: input.timeoutMs })
      .catch(() => undefined);
    await page
      .locator("#cSketch .card")
      .first()
      .waitFor({
        state: "attached",
        timeout: Math.min(input.timeoutMs, 10_000)
      })
      .catch(() => undefined);

    const courseShellDetected =
      (await page.locator("#cCourse").count()) > 0;
    const categoryTabCount = await page
      .locator("#cCourse .tabs .tab")
      .count();
    const visibleCardCount = await page
      .locator("#cSketch .card")
      .count();
    const visibleCardKeys = await createVisibleCardKeys({
      page,
      courseId,
      secret: evidenceSecret
    });
    const publicLoginControlDetected =
      (await page
        .locator(".cHeader .button")
        .filter({ hasText: "登录" })
        .count()) > 0;
    const detailObservation =
      detailObservationWithinReadOnlyBoundary(visibleCardCount);
    const selectedThreadKey = null;
    const detailEvidenceLevel: CmoocDetailEvidenceLevel = "none";
    const finalUrl = page.url();
    await context.close();
    return {
      finalUrl,
      browserRuntime: runtime,
      courseShellDetected,
      categoryTabCount,
      visibleCardCount,
      publicLoginControlDetected,
      detailObservation,
      allowedGetOrHeadCount,
      allowedSemanticReadPostCount,
      blockedWriteRequestCount,
      blockedCrossOriginRequestCount,
      apiAssistKinds: [...apiKinds],
      visibleCardKeys,
      selectedThreadKey,
      detailEvidenceLevel
    };
  } finally {
    await browser.close();
  }
}

export function readinessOutputRoot(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error(
      "未设置 LOCALAPPDATA，无法保存真实界面只读证据。"
    );
  }
  return path.resolve(
    localAppData,
    "cmooc-research",
    "lift1",
    "evidence-v1"
  );
}

function assertEvidenceHash(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error("真实界面证据哈希格式无效。");
  }
  return normalized;
}

function normalizeStoredReadinessReceipt(
  value: unknown
): CmoocUiReadinessReceipt {
  if (!value || typeof value !== "object") {
    throw new Error("真实界面证据不是对象。");
  }
  const receipt = value as Partial<CmoocUiReadinessReceipt>;
  if (
    receipt.schemaVersion !== CMOOC_UI_READINESS_SCHEMA_VERSION ||
    receipt.containsForumText !== false ||
    receipt.externalWriteAttempted !== false ||
    receipt.realPublishEnabled !== false ||
    typeof receipt.targetLocatorHash !== "string" ||
    !Number.isFinite(Date.parse(String(receipt.observedAt)))
  ) {
    throw new Error("真实界面证据未通过去正文与零写边界校验。");
  }
  return {
    ...(receipt as CmoocUiReadinessReceipt),
    visibleCardKeys: Array.isArray(receipt.visibleCardKeys)
      ? receipt.visibleCardKeys.filter(
          (value): value is string =>
            typeof value === "string" &&
            /^[a-f0-9]{24}$/i.test(value)
        )
      : [],
    selectedThreadKey:
      typeof receipt.selectedThreadKey === "string" &&
      /^[a-f0-9]{24}$/i.test(receipt.selectedThreadKey)
        ? receipt.selectedThreadKey
        : null,
    detailEvidenceLevel:
      receipt.detailEvidenceLevel === "ui_detail_observed" ||
      receipt.detailEvidenceLevel ===
        "ui_selected_api_correlated"
        ? receipt.detailEvidenceLevel
        : "none",
    requestedMutationCount:
      typeof receipt.requestedMutationCount === "number"
        ? receipt.requestedMutationCount
        : Number(receipt.blockedWriteRequestCount ?? 0),
    sentMutationCount: 0,
    networkGuardActive: true
  };
}

export async function loadCmoocUiReadinessEvidence(
  evidenceHash: string
): Promise<{
  receipt: CmoocUiReadinessReceipt;
  evidenceHash: string;
}> {
  const normalizedHash = assertEvidenceHash(evidenceHash);
  const evidencePath = path.join(
    readinessOutputRoot(),
    `${normalizedHash}.json`
  );
  const rawValue = JSON.parse(
    await readFile(evidencePath, "utf8")
  ) as CanonicalJsonValue;
  const rawRecord =
    rawValue &&
    typeof rawValue === "object" &&
    !Array.isArray(rawValue)
      ? (rawValue as {
          readonly [key: string]: CanonicalJsonValue;
        })
      : null;
  if (
    !rawRecord ||
    rawRecord.schemaVersion !== CMOOC_UI_READINESS_SCHEMA_VERSION
  ) {
    throw new Error("真实界面证据 schema 无效。");
  }
  const computedHash = canonicalProtocolHash(
    CMOOC_UI_READINESS_SCHEMA_VERSION,
    rawValue
  );
  if (!constantTimeEqualHex(computedHash, normalizedHash)) {
    throw new Error("真实界面证据哈希校验失败。");
  }
  return {
    receipt: normalizeStoredReadinessReceipt(rawValue),
    evidenceHash: normalizedHash
  };
}

export async function loadLatestCmoocUiReadinessEvidence(): Promise<{
  receipt: CmoocUiReadinessReceipt;
  evidenceHash: string;
} | null> {
  let files: string[];
  try {
    files = (await readdir(readinessOutputRoot()))
      .filter((name) => /^[a-f0-9]{64}\.json$/i.test(name))
      .slice(-200);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const candidates = await Promise.all(
    files.map(async (name) => {
      try {
        return await loadCmoocUiReadinessEvidence(
          name.slice(0, -".json".length)
        );
      } catch {
        return null;
      }
    })
  );
  return (
    candidates
      .filter(
        (
          value
        ): value is {
          receipt: CmoocUiReadinessReceipt;
          evidenceHash: string;
        } => value !== null
      )
      .sort(
        (left, right) =>
          Date.parse(right.receipt.observedAt) -
          Date.parse(left.receipt.observedAt)
      )[0] ?? null
  );
}

async function persistReceipt(input: {
  receipt: CmoocUiReadinessReceipt;
  evidenceHash: string;
}): Promise<string> {
  if (
    input.receipt.containsForumText ||
    input.receipt.externalWriteAttempted ||
    input.receipt.realPublishEnabled
  ) {
    throw new Error("拒绝保存越过只读或去正文边界的界面证据。");
  }
  const outputRoot = readinessOutputRoot();
  await mkdir(outputRoot, { recursive: true });
  const receiptPath = path.join(
    outputRoot,
    `${input.evidenceHash}.json`
  );
  await writeFile(
    receiptPath,
    `${JSON.stringify(input.receipt, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" }
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  return receiptPath;
}

export async function inspectCmoocUiReadiness(input: {
  targetInput: string;
  timeoutMs?: number;
  observedAt?: string;
}): Promise<CmoocUiReadinessResult> {
  const normalized = normalizeCmoocCourseTargetInput(
    input.targetInput
  );
  const observation = await observeCourseInterface({
    canonicalUrl: normalized.url,
    timeoutMs: input.timeoutMs ?? 20_000
  });
  const created = createCmoocUiReadinessReceipt({
    canonicalUrl: normalized.url,
    normalizationSource: normalized.source,
    inputWasNormalized: normalized.inputWasNormalized,
    observedAt: input.observedAt ?? new Date().toISOString(),
    observation
  });
  return {
    canonicalUrl: normalized.url,
    ...created,
    receiptPath: await persistReceipt(created)
  };
}
