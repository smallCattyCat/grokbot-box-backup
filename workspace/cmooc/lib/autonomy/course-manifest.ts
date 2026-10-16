import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "@/lib/facilitation-protocol";

export const COURSE_MANIFEST_SCHEMA_VERSION =
  "cmooc.course-manifest.v1" as const;
export const COURSE_MANIFEST_TEMPLATE_SCHEMA_VERSION =
  "cmooc.course-manifest-template.v1" as const;
export const COURSE_MANIFEST_SCHEMA_VERSION_V2 =
  "platform.course-manifest.v2" as const;
export const COURSE_MANIFEST_TEMPLATE_SCHEMA_VERSION_V2 =
  "platform.course-manifest-template.v2" as const;

// Descriptive aliases for callers that do not need to know the versioned
// constant naming convention. The cMOOC v1 constants above remain unchanged.
export const GENERIC_COURSE_MANIFEST_SCHEMA_VERSION =
  COURSE_MANIFEST_SCHEMA_VERSION_V2;
export const GENERIC_COURSE_MANIFEST_TEMPLATE_SCHEMA_VERSION =
  COURSE_MANIFEST_TEMPLATE_SCHEMA_VERSION_V2;

export type AutonomyMode =
  | "OBSERVE"
  | "SHADOW"
  | "STAGE"
  | "AUTO"
  | "HALTED";

export type CourseManifestV1 = {
  schemaVersion: typeof COURSE_MANIFEST_SCHEMA_VERSION;
  alias: string;
  platformId: "cmooc.bnu";
  courseId: string;
  courseIdSha256: string;
  canonicalUrl: string;
  allowedOrigins: string[];
  adapterId: string;
  timeZone: string;
  defaultMode: AutonomyMode;
  policyVersion: string;
  scan: {
    maxThreadsPerTick: number;
    maxCommentsPerThread: number;
    pageSize: number;
  };
  budget: {
    dailySlots: number;
    workloadCost: number;
    authorTouchLimit30d: number;
  };
  schedule: {
    intervalMinutes: number;
    leaseSeconds: number;
  };
  realPublishEnabled: false;
  manifestHash: string;
  sourcePath: string;
};

export type CourseManifestTemplate = {
  schemaVersion: typeof COURSE_MANIFEST_TEMPLATE_SCHEMA_VERSION;
  alias: string;
  platformId: "cmooc.bnu";
  courseIdSha256: string;
  canonicalOrigin: string;
  canonicalPath: string;
  timeZone: string;
  defaultMode: AutonomyMode;
  policyVersion: string;
  realPublishEnabled: false;
};

/**
 * A platform-neutral manifest. v2 deliberately keeps the opaque course
 * reference in the manifest while binding it by hash, so connectors do not
 * have to expose a numeric or URL-derived identifier.
 */
export type CourseManifestV2 = {
  schemaVersion: typeof COURSE_MANIFEST_SCHEMA_VERSION_V2;
  alias: string;
  platformId: string;
  courseId: string;
  courseIdHash: string;
  canonicalUrl: string;
  canonicalUrlHash: string;
  allowedOrigins: string[];
  adapterId: string;
  timeZone: string;
  defaultMode: AutonomyMode;
  policyVersion: string;
  scan: {
    maxThreadsPerTick: number;
    maxCommentsPerThread: number;
    pageSize: number;
  };
  budget: {
    dailySlots: number;
    workloadCost: number;
    authorTouchLimit30d: number;
  };
  schedule: {
    intervalMinutes: number;
    leaseSeconds: number;
  };
  realPublishEnabled: false;
  manifestHash: string;
  sourcePath: string;
};

export type CourseManifestTemplateV2 = {
  schemaVersion: typeof COURSE_MANIFEST_TEMPLATE_SCHEMA_VERSION_V2;
  alias: string;
  platformId: string;
  adapterId: string;
  courseIdHash: string;
  canonicalUrlHash: string;
  allowedOrigins: string[];
  timeZone: string;
  defaultMode: AutonomyMode;
  policyVersion: string;
  realPublishEnabled: false;
};

export type GenericCourseManifest = CourseManifestV2;
export type GenericCourseManifestTemplate = CourseManifestTemplateV2;
/** Public runtime inputs accept either the legacy cMOOC v1 or generic v2. */
export type CourseManifest = CourseManifestV1 | CourseManifestV2;
export type AnyCourseManifest = CourseManifest;
export type AnyCourseManifestTemplate =
  | CourseManifestTemplate
  | CourseManifestTemplateV2;

const MODES = new Set<AutonomyMode>([
  "OBSERVE",
  "SHADOW",
  "STAGE",
  "AUTO",
  "HALTED"
]);
const ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const COURSE_ID_PATTERN = /^\d{8,64}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const PLATFORM_OR_ADAPTER_ID_MAX_LENGTH = 160;
const OPAQUE_COURSE_REF_MAX_LENGTH = 512;

function recordValue(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function requiredString(
  value: unknown,
  label: string,
  maxLength = 2048
): string {
  if (typeof value !== "string") {
    throw new Error(`${label}必须是字符串。`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${label}不能为空且不能超过 ${maxLength} 个字符。`);
  }
  return normalized;
}

function positiveInteger(
  value: unknown,
  label: string,
  max: number
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > max
  ) {
    throw new Error(`${label}必须是 1 到 ${max} 的安全整数。`);
  }
  return value;
}

function parseMode(value: unknown, label: string): AutonomyMode {
  const normalized = requiredString(value, label, 20).toUpperCase();
  if (!MODES.has(normalized as AutonomyMode)) {
    throw new Error(`${label}不在允许运行模式中。`);
  }
  return normalized as AutonomyMode;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requiredExactIdentifier(
  value: unknown,
  label: string
): string {
  const normalized = requiredString(
    value,
    label,
    PLATFORM_OR_ADAPTER_ID_MAX_LENGTH
  );
  if (
    normalized !== value ||
    /[\u0000-\u001f\u007f\s]/u.test(normalized)
  ) {
    throw new Error(`${label}必须是无空白的精确标识。`);
  }
  return normalized;
}

function requiredHash(value: unknown, label: string): string {
  const normalized = requiredString(value, label, 64).toLowerCase();
  if (!HASH_PATTERN.test(normalized)) {
    throw new Error(`${label}必须是 SHA-256。`);
  }
  return normalized;
}

function parseHttpsOrigin(value: unknown, label: string): string {
  const raw = requiredString(value, label, 200);
  const parsed = new URL(raw);
  if (
    parsed.protocol !== "https:" ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(`${label}必须是无路径和凭据的 HTTPS origin。`);
  }
  return parsed.origin;
}

function parseV2AllowedOrigins(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1) {
    throw new Error("v2 课程 manifest 必须声明至少一个允许 origin。");
  }
  const origins = value.map((origin) =>
    parseHttpsOrigin(origin, "允许 origin")
  );
  if (new Set(origins).size !== origins.length) {
    throw new Error("v2 课程 manifest 的允许 origin 不能重复。");
  }
  return origins;
}

function assertExactStringArray(
  actual: readonly string[],
  expected: readonly string[],
  message: string
): void {
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new Error(message);
  }
}

function parseTemplateV1(
  value: unknown,
  expectedAlias: string
): CourseManifestTemplate {
  const input = recordValue(value, "课程 manifest 模板");
  if (
    input.schemaVersion !==
    COURSE_MANIFEST_TEMPLATE_SCHEMA_VERSION
  ) {
    throw new Error("课程 manifest 模板 schema 无效。");
  }
  const alias = requiredString(input.alias, "课程别名", 63);
  if (alias !== expectedAlias || !ALIAS_PATTERN.test(alias)) {
    throw new Error("课程 manifest 模板别名不匹配。");
  }
  const courseIdSha256 = requiredString(
    input.courseIdSha256,
    "课程标识摘要",
    64
  ).toLowerCase();
  if (!HASH_PATTERN.test(courseIdSha256)) {
    throw new Error("课程标识摘要必须是 SHA-256。");
  }
  const canonicalOrigin = new URL(
    requiredString(input.canonicalOrigin, "课程规范 origin")
  );
  if (
    canonicalOrigin.protocol !== "https:" ||
    canonicalOrigin.pathname !== "/" ||
    canonicalOrigin.search ||
    canonicalOrigin.hash ||
    canonicalOrigin.username ||
    canonicalOrigin.password
  ) {
    throw new Error("课程规范 origin 必须是无路径和凭据的 HTTPS origin。");
  }
  const canonicalPath = requiredString(
    input.canonicalPath,
    "课程规范路径",
    200
  );
  if (!canonicalPath.startsWith("/")) {
    throw new Error("课程规范路径必须是绝对路径。");
  }
  if (input.platformId !== "cmooc.bnu") {
    throw new Error("课程平台标识无效。");
  }
  if (input.realPublishEnabled !== false) {
    throw new Error("仓库模板不得启用真实发布。");
  }
  return {
    schemaVersion: COURSE_MANIFEST_TEMPLATE_SCHEMA_VERSION,
    alias,
    platformId: "cmooc.bnu",
    courseIdSha256,
    canonicalOrigin: canonicalOrigin.origin,
    canonicalPath,
    timeZone: requiredString(input.timeZone, "课程时区", 80),
    defaultMode: parseMode(input.defaultMode, "默认运行模式"),
    policyVersion: requiredString(
      input.policyVersion,
      "策略版本",
      160
    ),
    realPublishEnabled: false
  };
}

function parseCourseManifestV1(input: {
  value: unknown;
  template: CourseManifestTemplate;
  sourcePath: string;
}): CourseManifestV1 {
  const value = recordValue(input.value, "课程 manifest");
  if (value.schemaVersion !== COURSE_MANIFEST_SCHEMA_VERSION) {
    throw new Error("课程 manifest schema 无效。");
  }
  const alias = requiredString(value.alias, "课程别名", 63);
  if (
    alias !== input.template.alias ||
    !ALIAS_PATTERN.test(alias)
  ) {
    throw new Error("课程 manifest 与模板别名不一致。");
  }
  if (value.platformId !== input.template.platformId) {
    throw new Error("课程 manifest 平台不匹配。");
  }
  const courseId = requiredString(
    value.courseId,
    "课程标识",
    64
  );
  if (!COURSE_ID_PATTERN.test(courseId)) {
    throw new Error("课程标识格式无效。");
  }
  const courseIdSha256 = sha256(courseId);
  if (courseIdSha256 !== input.template.courseIdSha256) {
    throw new Error("课程 manifest 未绑定到允许的精确课程标识。");
  }
  const canonicalUrl = new URL(
    requiredString(value.canonicalUrl, "课程规范地址")
  );
  if (
    canonicalUrl.protocol !== "https:" ||
    canonicalUrl.origin !== input.template.canonicalOrigin ||
    canonicalUrl.pathname !== input.template.canonicalPath ||
    canonicalUrl.searchParams.get("courseId") !== courseId ||
    canonicalUrl.searchParams.get("isBack") !== "1" ||
    canonicalUrl.username ||
    canonicalUrl.password ||
    canonicalUrl.hash
  ) {
    throw new Error("课程规范地址的 origin、路径或 courseId 不匹配。");
  }
  const allowedOriginsInput = value.allowedOrigins;
  if (
    !Array.isArray(allowedOriginsInput) ||
    allowedOriginsInput.length !== 1
  ) {
    throw new Error("课程 manifest 必须且只能声明一个允许 origin。");
  }
  const allowedOrigins = allowedOriginsInput.map((origin) => {
    const parsed = new URL(
      requiredString(origin, "允许 origin", 200)
    );
    if (
      parsed.protocol !== "https:" ||
      parsed.origin !== input.template.canonicalOrigin ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("课程允许 origin 与规范 origin 不一致。");
    }
    return parsed.origin;
  });
  const scan = recordValue(value.scan, "课程扫描参数");
  const budget = recordValue(value.budget, "课程预算参数");
  const schedule = recordValue(value.schedule, "课程调度参数");
  const defaultMode = parseMode(value.defaultMode, "默认运行模式");
  if (
    defaultMode !== input.template.defaultMode ||
    value.timeZone !== input.template.timeZone ||
    value.policyVersion !== input.template.policyVersion
  ) {
    throw new Error("课程 manifest 的模式、时区或策略版本与模板不一致。");
  }
  if (value.realPublishEnabled !== false) {
    throw new Error("当前课程 manifest 必须保持真实发布关闭。");
  }
  const normalized = {
    schemaVersion: COURSE_MANIFEST_SCHEMA_VERSION,
    alias,
    platformId: "cmooc.bnu" as const,
    courseIdSha256,
    canonicalLocatorHash: sha256(canonicalUrl.toString()),
    allowedOrigins,
    adapterId: requiredString(
      value.adapterId,
      "课程 adapter",
      120
    ),
    timeZone: input.template.timeZone,
    defaultMode,
    policyVersion: input.template.policyVersion,
    scan: {
      maxThreadsPerTick: positiveInteger(
        scan.maxThreadsPerTick,
        "每轮最大线程数",
        10_000
      ),
      maxCommentsPerThread: positiveInteger(
        scan.maxCommentsPerThread,
        "每线程最大评论数",
        10_000
      ),
      pageSize: positiveInteger(
        scan.pageSize,
        "扫描分页大小",
        500
      )
    },
    budget: {
      dailySlots: positiveInteger(
        budget.dailySlots,
        "每日预算槽位",
        10_000
      ),
      workloadCost: positiveInteger(
        budget.workloadCost,
        "单次工作量成本",
        100
      ),
      authorTouchLimit30d: positiveInteger(
        budget.authorTouchLimit30d,
        "30 日作者触达上限",
        100
      )
    },
    schedule: {
      intervalMinutes: positiveInteger(
        schedule.intervalMinutes,
        "调度间隔",
        10_080
      ),
      leaseSeconds: positiveInteger(
        schedule.leaseSeconds,
        "租约秒数",
        3_600
      )
    },
    realPublishEnabled: false as const
  };
  return {
    ...normalized,
    courseId,
    canonicalUrl: canonicalUrl.toString(),
    manifestHash: canonicalProtocolHash(
      COURSE_MANIFEST_SCHEMA_VERSION,
      normalized as unknown as CanonicalJsonValue
    ),
    sourcePath: path.resolve(input.sourcePath)
  };
}

function requiredOpaqueCourseRef(value: unknown): string {
  const normalized = requiredString(
    value,
    "课程标识",
    OPAQUE_COURSE_REF_MAX_LENGTH
  );
  if (
    normalized !== value ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new Error("课程标识必须是精确的可见字符引用。");
  }
  return normalized;
}

export function parseCourseManifestTemplateV2(
  value: unknown,
  expectedAlias?: string
): CourseManifestTemplateV2 {
  const input = recordValue(value, "课程 manifest 模板");
  if (
    input.schemaVersion !==
    COURSE_MANIFEST_TEMPLATE_SCHEMA_VERSION_V2
  ) {
    throw new Error("v2 课程 manifest 模板 schema 无效。");
  }
  const alias = requiredString(input.alias, "课程别名", 63);
  if (
    (expectedAlias !== undefined && alias !== expectedAlias) ||
    !ALIAS_PATTERN.test(alias)
  ) {
    throw new Error("v2 课程 manifest 模板别名不匹配。");
  }
  const platformId = requiredExactIdentifier(
    input.platformId,
    "课程平台标识"
  );
  const adapterId = requiredExactIdentifier(
    input.adapterId,
    "课程 adapter"
  );
  const courseIdHash = requiredHash(
    input.courseIdHash,
    "课程标识摘要"
  );
  const canonicalUrlHash = requiredHash(
    input.canonicalUrlHash,
    "课程规范地址摘要"
  );
  const allowedOrigins = parseV2AllowedOrigins(input.allowedOrigins);
  if (input.realPublishEnabled !== false) {
    throw new Error("v2 仓库模板不得启用真实发布。");
  }
  return {
    schemaVersion: COURSE_MANIFEST_TEMPLATE_SCHEMA_VERSION_V2,
    alias,
    platformId,
    adapterId,
    courseIdHash,
    canonicalUrlHash,
    allowedOrigins,
    timeZone: requiredString(input.timeZone, "课程时区", 80),
    defaultMode: parseMode(input.defaultMode, "默认运行模式"),
    policyVersion: requiredString(
      input.policyVersion,
      "策略版本",
      160
    ),
    realPublishEnabled: false
  };
}

export function parseCourseManifestV2(input: {
  value: unknown;
  template: CourseManifestTemplateV2;
  sourcePath: string;
}): CourseManifestV2 {
  const value = recordValue(input.value, "课程 manifest");
  if (value.schemaVersion !== COURSE_MANIFEST_SCHEMA_VERSION_V2) {
    throw new Error("v2 课程 manifest schema 无效。");
  }
  const template = parseCourseManifestTemplateV2(input.template);
  const alias = requiredString(value.alias, "课程别名", 63);
  if (alias !== template.alias || !ALIAS_PATTERN.test(alias)) {
    throw new Error("v2 课程 manifest 与模板别名不一致。");
  }
  const platformId = requiredExactIdentifier(
    value.platformId,
    "课程平台标识"
  );
  if (platformId !== template.platformId) {
    throw new Error("v2 课程 manifest 平台不匹配。");
  }
  const adapterId = requiredExactIdentifier(
    value.adapterId,
    "课程 adapter"
  );
  if (adapterId !== template.adapterId) {
    throw new Error("v2 课程 manifest adapter 不匹配。");
  }

  const courseId = requiredOpaqueCourseRef(value.courseId);
  const courseIdHash = requiredHash(
    value.courseIdHash,
    "课程标识摘要"
  );
  if (
    courseIdHash !== sha256(courseId) ||
    courseIdHash !== template.courseIdHash
  ) {
    throw new Error("v2 课程 manifest 未绑定到允许的精确课程标识。");
  }

  const canonicalUrl = new URL(
    requiredString(value.canonicalUrl, "课程规范地址")
  );
  if (
    canonicalUrl.protocol !== "https:" ||
    canonicalUrl.username ||
    canonicalUrl.password ||
    canonicalUrl.hash
  ) {
    throw new Error("v2 课程规范地址必须是无凭据和 hash 的 HTTPS 地址。");
  }
  const canonicalUrlString = canonicalUrl.toString();
  const canonicalUrlHash = requiredHash(
    value.canonicalUrlHash,
    "课程规范地址摘要"
  );
  if (
    canonicalUrlHash !== sha256(canonicalUrlString) ||
    canonicalUrlHash !== template.canonicalUrlHash
  ) {
    throw new Error("v2 课程规范地址未绑定到允许的精确地址。");
  }

  const allowedOrigins = parseV2AllowedOrigins(value.allowedOrigins);
  assertExactStringArray(
    allowedOrigins,
    template.allowedOrigins,
    "v2 课程允许 origin 与模板不一致。"
  );
  if (!allowedOrigins.includes(canonicalUrl.origin)) {
    throw new Error("v2 课程规范地址不在允许 origin 中。");
  }

  const scan = recordValue(value.scan, "课程扫描参数");
  const budget = recordValue(value.budget, "课程预算参数");
  const schedule = recordValue(value.schedule, "课程调度参数");
  const defaultMode = parseMode(value.defaultMode, "默认运行模式");
  if (
    defaultMode !== template.defaultMode ||
    value.timeZone !== template.timeZone ||
    value.policyVersion !== template.policyVersion
  ) {
    throw new Error("v2 课程 manifest 的模式、时区或策略版本与模板不一致。");
  }
  if (value.realPublishEnabled !== false) {
    throw new Error("当前 v2 课程 manifest 必须保持真实发布关闭。");
  }

  const normalized = {
    schemaVersion: COURSE_MANIFEST_SCHEMA_VERSION_V2,
    alias,
    platformId,
    adapterId,
    courseIdHash,
    canonicalUrlHash,
    allowedOrigins,
    timeZone: template.timeZone,
    defaultMode,
    policyVersion: template.policyVersion,
    scan: {
      maxThreadsPerTick: positiveInteger(
        scan.maxThreadsPerTick,
        "每轮最大线程数",
        10_000
      ),
      maxCommentsPerThread: positiveInteger(
        scan.maxCommentsPerThread,
        "每线程最大评论数",
        10_000
      ),
      pageSize: positiveInteger(
        scan.pageSize,
        "扫描分页大小",
        500
      )
    },
    budget: {
      dailySlots: positiveInteger(
        budget.dailySlots,
        "每日预算槽位",
        10_000
      ),
      workloadCost: positiveInteger(
        budget.workloadCost,
        "单次工作量成本",
        100
      ),
      authorTouchLimit30d: positiveInteger(
        budget.authorTouchLimit30d,
        "30 日作者触达上限",
        100
      )
    },
    schedule: {
      intervalMinutes: positiveInteger(
        schedule.intervalMinutes,
        "调度间隔",
        10_080
      ),
      leaseSeconds: positiveInteger(
        schedule.leaseSeconds,
        "租约秒数",
        3_600
      )
    },
    realPublishEnabled: false as const
  };
  return {
    ...normalized,
    courseId,
    canonicalUrl: canonicalUrlString,
    manifestHash: canonicalProtocolHash(
      COURSE_MANIFEST_SCHEMA_VERSION_V2,
      normalized as unknown as CanonicalJsonValue
    ),
    sourcePath: path.resolve(input.sourcePath)
  };
}

export function parseCourseManifestTemplate(
  value: unknown,
  expectedAlias?: string
): AnyCourseManifestTemplate {
  const input = recordValue(value, "课程 manifest 模板");
  if (
    input.schemaVersion ===
    COURSE_MANIFEST_TEMPLATE_SCHEMA_VERSION_V2
  ) {
    return parseCourseManifestTemplateV2(input, expectedAlias);
  }
  if (expectedAlias === undefined) {
    throw new Error("v1 课程 manifest 模板必须提供预期课程别名。");
  }
  return parseTemplateV1(input, expectedAlias);
}

export function parseCourseManifest(input: {
  value: unknown;
  template: CourseManifestTemplate;
  sourcePath: string;
}): CourseManifestV1;
export function parseCourseManifest(input: {
  value: unknown;
  template: CourseManifestTemplateV2;
  sourcePath: string;
}): CourseManifestV2;
export function parseCourseManifest(input: {
  value: unknown;
  template: AnyCourseManifestTemplate;
  sourcePath: string;
}): AnyCourseManifest;
export function parseCourseManifest(input: {
  value: unknown;
  template: AnyCourseManifestTemplate;
  sourcePath: string;
}): AnyCourseManifest {
  const value = recordValue(input.value, "课程 manifest");
  if (value.schemaVersion === COURSE_MANIFEST_SCHEMA_VERSION_V2) {
    if (
      input.template.schemaVersion !==
      COURSE_MANIFEST_TEMPLATE_SCHEMA_VERSION_V2
    ) {
      throw new Error("v2 课程 manifest 必须使用 v2 模板。");
    }
    return parseCourseManifestV2({
      value,
      template: input.template,
      sourcePath: input.sourcePath
    });
  }
  if (
    input.template.schemaVersion !==
    COURSE_MANIFEST_TEMPLATE_SCHEMA_VERSION
  ) {
    throw new Error("v1 课程 manifest 必须使用 v1 模板。");
  }
  return parseCourseManifestV1({
    value,
    template: input.template,
    sourcePath: input.sourcePath
  });
}

function manifestFileName(alias: string): string {
  if (!ALIAS_PATTERN.test(alias)) {
    throw new Error("课程别名格式无效。");
  }
  return `${alias}-course.json`;
}

function manifestRoots(explicitRoot?: string): string[] {
  const roots = [
    explicitRoot,
    process.env.COURSE_MANIFEST_DIR,
    process.env.CMOOC_COURSE_MANIFEST_DIR,
    path.resolve(process.cwd(), "configs", "courses", "local")
  ];
  if (process.env.LOCALAPPDATA) {
    roots.push(
      path.resolve(
        process.env.LOCALAPPDATA,
        "cmooc-research",
        "autonomy",
        "course-manifests"
      )
    );
  }
  return [
    ...new Set(
      roots
        .filter((value): value is string => Boolean(value?.trim()))
        .map((value) => path.resolve(value))
    )
  ];
}

export async function loadCourseManifest(
  alias: string,
  options: { manifestRoot?: string } = {}
): Promise<CourseManifestV1> {
  const fileName = manifestFileName(alias);
  const templatePath = path.resolve(
    process.cwd(),
    "configs",
    "courses",
    `${alias}-course.template.json`
  );
  const template = parseTemplateV1(
    JSON.parse(await readFile(templatePath, "utf8")),
    alias
  );
  const attempted: string[] = [];
  for (const root of manifestRoots(options.manifestRoot)) {
    const candidate = path.resolve(root, fileName);
    if (path.dirname(candidate) !== root) {
      throw new Error("课程 manifest 路径越界。");
    }
    attempted.push(candidate);
    try {
      return parseCourseManifest({
        value: JSON.parse(await readFile(candidate, "utf8")),
        template,
        sourcePath: candidate
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
  throw new Error(
    `未找到课程 ${alias} 的本地精确 manifest；已检查 ${attempted.length} 个受控目录。`
  );
}

export async function loadCourseManifestV2(
  alias: string,
  options: { manifestRoot?: string } = {}
): Promise<CourseManifestV2> {
  const fileName = manifestFileName(alias);
  const templatePath = path.resolve(
    process.cwd(),
    "configs",
    "courses",
    `${alias}-course.template.json`
  );
  const template = parseCourseManifestTemplateV2(
    JSON.parse(await readFile(templatePath, "utf8")),
    alias
  );
  const attempted: string[] = [];
  for (const root of manifestRoots(options.manifestRoot)) {
    const candidate = path.resolve(root, fileName);
    if (path.dirname(candidate) !== root) {
      throw new Error("课程 manifest 路径越界。");
    }
    attempted.push(candidate);
    try {
      return parseCourseManifestV2({
        value: JSON.parse(await readFile(candidate, "utf8")),
        template,
        sourcePath: candidate
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
  throw new Error(
    `未找到课程 ${alias} 的 v2 本地精确 manifest；已检查 ${attempted.length} 个受控目录。`
  );
}

/**
 * Load either a legacy cMOOC v1 manifest or a platform-neutral v2 manifest.
 * The existing loadCourseManifest function intentionally remains v1-only for
 * callers whose public contract is the historical cMOOC shape.
 */
export async function loadAnyCourseManifest(
  alias: string,
  options: { manifestRoot?: string } = {}
): Promise<AnyCourseManifest> {
  const fileName = manifestFileName(alias);
  const templatePath = path.resolve(
    process.cwd(),
    "configs",
    "courses",
    `${alias}-course.template.json`
  );
  const template = parseCourseManifestTemplate(
    JSON.parse(await readFile(templatePath, "utf8")),
    alias
  );
  const attempted: string[] = [];
  for (const root of manifestRoots(options.manifestRoot)) {
    const candidate = path.resolve(root, fileName);
    if (path.dirname(candidate) !== root) {
      throw new Error("课程 manifest 路径越界。");
    }
    attempted.push(candidate);
    try {
      return parseCourseManifest({
        value: JSON.parse(await readFile(candidate, "utf8")),
        template,
        sourcePath: candidate
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
  throw new Error(
    `未找到课程 ${alias} 的 v1/v2 本地精确 manifest；已检查 ${attempted.length} 个受控目录。`
  );
}

export const loadGenericCourseManifest = loadAnyCourseManifest;

export function normalizeRequestedMode(
  requested: string | undefined,
  manifest: AnyCourseManifest
): AutonomyMode {
  const mode = requested
    ? parseMode(requested, "请求运行模式")
    : manifest.defaultMode;
  if (mode === "AUTO" && !manifest.realPublishEnabled) {
    throw new Error(
      "当前 manifest 的真实发布硬锁关闭，不能激活 AUTO。"
    );
  }
  if (mode === "STAGE") {
    throw new Error(
      "autonomy:tick 不直接执行 STAGE；必须由认证 Chrome companion 完成。"
    );
  }
  return mode;
}
