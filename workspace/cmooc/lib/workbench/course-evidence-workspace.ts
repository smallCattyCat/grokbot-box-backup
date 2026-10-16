import { canonicalProtocolHash } from "@/lib/facilitation-protocol/canonical-hash";

export const COURSE_EVIDENCE_WORKSPACE_SCHEMA_VERSION =
  "cmooc.course-evidence-workspace.v1" as const;
export const COURSE_RESEARCH_EXPORT_SCHEMA_VERSION =
  "cmooc.course-research-export.v1" as const;
export const PERSISTED_EVIDENCE_QUALIFICATION_SCHEMA_VERSION =
  "cmooc.persisted-evidence-qualification.v1" as const;

export type EvidenceWaterfallState =
  | "pass"
  | "fail"
  | "unknown"
  | "not_evaluated";

export type EvidenceWaterfallStageKey =
  | "label"
  | "format"
  | "evidence"
  | "relation"
  | "time"
  | "support";

export type EvidenceWaterfallStage = {
  key: EvidenceWaterfallStageKey;
  label: string;
  state: EvidenceWaterfallState;
  summary: string;
};

export type EvidenceQualificationInput = {
  answerability: "qualified" | "unanswerable" | "unknown";
  formatValid: boolean | null;
  evidenceLegal: boolean | null;
  relationCorrect: boolean | null;
  temporalLegal: boolean | null;
  supportResolution: "resolved" | "unresolved" | "conflicting" | "unknown";
};

/**
 * Safe projection of the qualification produced by the live opportunity
 * kernel. The projection deliberately carries no observation body, identity,
 * target locator, or model output. Writers and readers share the hash helper
 * below so a JSON field cannot silently be substituted after the opportunity
 * receipt was committed.
 */
export type PersistedEvidenceQualification = {
  answerability: "qualified" | "unanswerable";
  formatValid: true;
  evidenceLegal: boolean;
  relationCorrect: boolean;
  temporalLegal: boolean;
  supportResolution: "resolved" | "unresolved" | "conflicting";
  appropriateAbstention: boolean;
  decision: "qualify" | "abstain" | "review";
  reasonCodes: string[];
};

export function hashPersistedEvidenceQualification(input: {
  opportunityReceiptHash: string;
  qualification: PersistedEvidenceQualification;
}): string {
  return canonicalProtocolHash(
    PERSISTED_EVIDENCE_QUALIFICATION_SCHEMA_VERSION,
    {
      schemaVersion: PERSISTED_EVIDENCE_QUALIFICATION_SCHEMA_VERSION,
      opportunityReceiptHash: input.opportunityReceiptHash,
      qualification: input.qualification,
      containsForumText: false
    }
  );
}

export type CourseEvidenceWorkspace = {
  schemaVersion: typeof COURSE_EVIDENCE_WORKSPACE_SCHEMA_VERSION;
  status: "ready" | "unavailable";
  anchor: {
    courseAlias: string;
    invocationId: string;
    snapshotId: string;
    baselineSnapshotId: string | null;
    worldAsOf: string;
    baselineAsOf: string | null;
  } | null;
  waterfall: {
    status: "qualified" | "stopped" | "unknown" | "unavailable";
    headline: string;
    stopAt: string | null;
    missing: string[];
    stages: EvidenceWaterfallStage[];
  };
  change: {
    status: "comparable" | "lower_bound" | "unavailable";
    baselineAsOf: string | null;
    currentAsOf: string | null;
    metrics: Array<{
      key: "events" | "threads" | "actors" | "edges" | "support_gaps";
      label: string;
      before: number | null;
      after: number | null;
      delta: number | null;
    }>;
    summary: string;
    limitation: string;
  };
  portrait: {
    status: "supported" | "lower_bound" | "unavailable";
    completeUnitShare: number | null;
    completeUnitCount: number;
    totalUnitCount: number;
    observedEventShare: number | null;
    observedEventCount: number;
    declaredEventCount: number;
    unsupportedEventShare: number | null;
    allObservedUnitCount: number;
    eligibleCompleteUnitCount: number;
    unsupportedUnitCount: number;
    unsupportedUnitShare: number | null;
    observationCoverage: {
      completedDetailCount: number;
      discoveredThreadCount: number;
      share: number | null;
    };
    matureSupportGapCount: number;
    /**
     * Missing-support identification range. This is deliberately not a
     * confidence interval: unsupported units may or may not contain a mature
     * support gap.
     */
    compatibleRange: {
      lower: number | null;
      upper: number | null;
      basis: string;
      kind: "identification_interval_not_confidence_interval";
    } | null;
    interactionCoverage: "complete" | "lower_bound" | "unavailable";
    functionMappingStatus: "unavailable";
    summary: string;
    limitation: string;
  };
  research: {
    exportHref: string;
    format: "canonical_json";
    includes: string[];
    excludes: string[];
    deterministic: true;
  };
  containsForumText: false;
  containsIdentity: false;
};

type SnapshotSummary = {
  id: string;
  courseAlias: string;
  invocationId: string;
  asOfAt: Date;
  eventCount: number;
  threadCount: number;
  actorCount: number;
  edgeCount: number;
  openGapCount: number;
};

export type BuildCourseEvidenceWorkspaceInput = {
  anchor: {
    courseAlias: string;
    invocationId: string;
    snapshotId: string;
  };
  current: SnapshotSummary;
  baseline: SnapshotSummary | null;
  coverage: {
    status: "complete" | "partial" | "unavailable";
    discoveredThreadCount: number;
    completedDetailCount: number;
    observedEventCount: number;
    incompleteThreadCount: number;
    failedTargetCount: number;
  };
  qualification: EvidenceQualificationInput | null;
  matureSupportGapCount: number;
  threadSupport?: {
    allObservedUnitCount: number;
    eligibleCompleteUnitCount: number;
    unsupportedUnitCount: number;
  };
  baselineCoverageStatus?: "complete" | "partial" | "unavailable";
  graph: {
    status: "complete" | "censored" | "unavailable";
  };
};

const STAGE_COPY: Record<
  EvidenceWaterfallStageKey,
  { label: string; pass: string; fail: string; unknown: string }
> = {
  label: {
    label: "标签",
    pass: "结论类型可判定",
    fail: "结论不可可靠判定",
    unknown: "没有持久化的判定资格"
  },
  format: {
    label: "格式",
    pass: "输出结构符合契约",
    fail: "输出结构不符合契约",
    unknown: "格式证据不可用"
  },
  evidence: {
    label: "证据",
    pass: "来源与资格证据合法",
    fail: "来源或资格证据不足",
    unknown: "证据资格尚未确认"
  },
  relation: {
    label: "关系",
    pass: "关系目标得到支持",
    fail: "关系目标未得到支持",
    unknown: "关系目标尚未解决"
  },
  time: {
    label: "时间",
    pass: "严格时间前缀成立",
    fail: "时间合法性不成立",
    unknown: "时间证据尚未确认"
  },
  support: {
    label: "支撑",
    pass: "结论支撑已经解决",
    fail: "支撑证据相互冲突",
    unknown: "支撑仍未解决"
  }
};

const STAGE_ORDER: EvidenceWaterfallStageKey[] = [
  "label",
  "format",
  "evidence",
  "relation",
  "time",
  "support"
];

function safeCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return null;
  }
  return Math.max(0, Math.min(1, numerator / denominator));
}

function rounded(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10_000) / 10_000;
}

function qualificationStates(
  qualification: EvidenceQualificationInput | null
): Record<EvidenceWaterfallStageKey, EvidenceWaterfallState> {
  if (!qualification) {
    return Object.fromEntries(
      STAGE_ORDER.map((key) => [key, "unknown"])
    ) as Record<EvidenceWaterfallStageKey, EvidenceWaterfallState>;
  }
  return {
    label:
      qualification.answerability === "qualified"
        ? "pass"
        : qualification.answerability === "unanswerable"
          ? "fail"
          : "unknown",
    format:
      qualification.formatValid === true
        ? "pass"
        : qualification.formatValid === false
          ? "fail"
          : "unknown",
    evidence:
      qualification.evidenceLegal === true
        ? "pass"
        : qualification.evidenceLegal === false
          ? "fail"
          : "unknown",
    relation:
      qualification.relationCorrect === true
        ? "pass"
        : qualification.relationCorrect === false
          ? "fail"
          : "unknown",
    time:
      qualification.temporalLegal === true
        ? "pass"
        : qualification.temporalLegal === false
          ? "fail"
          : "unknown",
    support:
      qualification.supportResolution === "resolved"
        ? "pass"
        : qualification.supportResolution === "conflicting"
          ? "fail"
          : "unknown"
  };
}

export function buildEvidenceWaterfall(
  qualification: EvidenceQualificationInput | null
): CourseEvidenceWorkspace["waterfall"] {
  const rawStates = qualificationStates(qualification);
  let stopped = false;
  const stages = STAGE_ORDER.map((key) => {
    const rawState = rawStates[key];
    const state: EvidenceWaterfallState = stopped ? "not_evaluated" : rawState;
    if (!stopped && (state === "fail" || state === "unknown")) stopped = true;
    const copy = STAGE_COPY[key];
    return {
      key,
      label: copy.label,
      state,
      summary:
        state === "pass"
          ? copy.pass
          : state === "fail"
            ? copy.fail
            : state === "unknown"
              ? copy.unknown
              : "前序资格未通过，本层未继续判定"
    };
  });
  const firstStop = stages.find(
    (stage) => stage.state === "fail" || stage.state === "unknown"
  );
  const missing = stages
    .filter((stage) => stage.state === "fail" || stage.state === "unknown")
    .map((stage) => stage.summary);
  if (!qualification) {
    return {
      status: "unavailable",
      headline: "本项没有持久化的逐层资格证据",
      stopAt: firstStop?.label ?? null,
      missing,
      stages
    };
  }
  if (!firstStop) {
    return {
      status: "qualified",
      headline: "六层证据资格均已通过",
      stopAt: null,
      missing: [],
      stages
    };
  }
  return {
    status: firstStop.state === "unknown" ? "unknown" : "stopped",
    headline:
      firstStop.state === "unknown"
        ? `证据停在“${firstStop.label}”层，仍需人工核验`
        : `证据停在“${firstStop.label}”层`,
    stopAt: firstStop.label,
    missing,
    stages
  };
}

function metric(
  key: CourseEvidenceWorkspace["change"]["metrics"][number]["key"],
  label: string,
  before: number | null,
  after: number | null
) {
  return {
    key,
    label,
    before,
    after,
    delta: before === null || after === null ? null : after - before
  };
}

function exactExportHref(anchor: BuildCourseEvidenceWorkspaceInput["anchor"]): string {
  const query = new URLSearchParams({
    courseAlias: anchor.courseAlias,
    invocationId: anchor.invocationId,
    snapshotId: anchor.snapshotId
  });
  return `/api/workbench/research-export?${query.toString()}`;
}

export function buildCourseEvidenceWorkspace(
  input: BuildCourseEvidenceWorkspaceInput
): CourseEvidenceWorkspace {
  const { anchor, current, baseline } = input;
  if (
    current.id !== anchor.snapshotId ||
    current.courseAlias !== anchor.courseAlias ||
    current.invocationId !== anchor.invocationId ||
    (baseline !== null &&
      (baseline.courseAlias !== anchor.courseAlias ||
        baseline.asOfAt.getTime() >= current.asOfAt.getTime() ||
        baseline.id === current.id))
  ) {
    throw new Error("EVIDENCE_WORKSPACE_ANCHOR_CONFLICT");
  }

  const comparable = baseline !== null;
  const allObservedUnitCount = safeCount(
    input.threadSupport?.allObservedUnitCount ??
      input.coverage.discoveredThreadCount
  );
  const completeCurrentUnits = Math.min(
    allObservedUnitCount,
    safeCount(
      input.threadSupport?.eligibleCompleteUnitCount ??
        allObservedUnitCount - safeCount(input.coverage.incompleteThreadCount)
    )
  );
  const completeUnitShare = ratio(
    completeCurrentUnits,
    allObservedUnitCount
  );
  const observedEventShare = ratio(
    safeCount(input.coverage.observedEventCount),
    safeCount(current.eventCount)
  );
  const unsupportedUnitCount = Math.min(
    allObservedUnitCount,
    safeCount(
      input.threadSupport?.unsupportedUnitCount ??
        allObservedUnitCount - completeCurrentUnits
    )
  );
  const unsupportedUnitShare = ratio(
    unsupportedUnitCount,
    allObservedUnitCount
  );
  const observationCoverageShare = ratio(
    safeCount(input.coverage.completedDetailCount),
    allObservedUnitCount
  );
  const compatibleRange =
    allObservedUnitCount > 0
      ? {
          lower: rounded(
            ratio(
              safeCount(input.matureSupportGapCount),
              allObservedUnitCount
            )
          ),
          upper: rounded(
            ratio(
              safeCount(input.matureSupportGapCount) + unsupportedUnitCount,
              allObservedUnitCount
            )
          ),
          basis: "成熟支持缺口占全部观察单位的下界，至把未支持单位全部计入后的上界",
          kind: "identification_interval_not_confidence_interval" as const
        }
      : null;
  const changeStatus = !comparable
    ? "unavailable"
    : input.coverage.status === "complete" &&
        (input.baselineCoverageStatus === undefined ||
          input.baselineCoverageStatus === "complete")
      ? "comparable"
      : "lower_bound";
  const portraitStatus =
    input.coverage.status === "complete" && input.graph.status === "complete"
      ? "supported"
      : input.coverage.status === "unavailable" || input.graph.status === "unavailable"
        ? "unavailable"
        : "lower_bound";

  return {
    schemaVersion: COURSE_EVIDENCE_WORKSPACE_SCHEMA_VERSION,
    status: "ready",
    anchor: {
      courseAlias: anchor.courseAlias,
      invocationId: anchor.invocationId,
      snapshotId: anchor.snapshotId,
      baselineSnapshotId: baseline?.id ?? null,
      worldAsOf: current.asOfAt.toISOString(),
      baselineAsOf: baseline?.asOfAt.toISOString() ?? null
    },
    waterfall: buildEvidenceWaterfall(input.qualification),
    change: {
      status: changeStatus,
      baselineAsOf: baseline?.asOfAt.toISOString() ?? null,
      currentAsOf: current.asOfAt.toISOString(),
      metrics: [
        metric("events", "事件", baseline?.eventCount ?? null, current.eventCount),
        metric("threads", "讨论", baseline?.threadCount ?? null, current.threadCount),
        metric("actors", "参与者", baseline?.actorCount ?? null, current.actorCount),
        metric("edges", "互动关系", baseline?.edgeCount ?? null, current.edgeCount),
        metric("support_gaps", "开放缺口", baseline?.openGapCount ?? null, current.openGapCount)
      ],
      summary: !comparable
        ? "没有更早且同课程的世界快照，当前不生成伪变化。"
        : changeStatus === "comparable"
          ? "当前快照可与最近一个同课程早期快照比较。"
          : "当前变化只按可见下界呈现。",
      limitation:
        "这些是结构计数的快照差异，不表示因果影响、学习成效或个体状态变化。"
    },
    portrait: {
      status: portraitStatus,
      completeUnitShare: rounded(completeUnitShare),
      completeUnitCount: completeCurrentUnits,
      totalUnitCount: safeCount(input.coverage.discoveredThreadCount),
      observedEventShare: rounded(observedEventShare),
      observedEventCount: safeCount(input.coverage.observedEventCount),
      declaredEventCount: safeCount(current.eventCount),
      unsupportedEventShare:
        observedEventShare === null ? null : rounded(1 - observedEventShare),
      allObservedUnitCount,
      eligibleCompleteUnitCount: completeCurrentUnits,
      unsupportedUnitCount,
      unsupportedUnitShare: rounded(unsupportedUnitShare),
      observationCoverage: {
        completedDetailCount: safeCount(input.coverage.completedDetailCount),
        discoveredThreadCount: allObservedUnitCount,
        share: rounded(observationCoverageShare)
      },
      matureSupportGapCount: safeCount(input.matureSupportGapCount),
      compatibleRange,
      interactionCoverage:
        input.graph.status === "complete"
          ? "complete"
          : input.graph.status === "censored"
            ? "lower_bound"
            : "unavailable",
      functionMappingStatus: "unavailable",
      summary:
        portraitStatus === "supported"
          ? "课程画像同时报告完整讨论单位与事件覆盖两个分母。"
          : portraitStatus === "lower_bound"
            ? "当前画像可用于局部理解，但只能按下界解释。"
            : "当前没有足够证据形成课程画像。",
      limitation:
        "相容范围是缺失边界下的识别区间，并非置信区间。互动功能五分类尚未在本快照中持久化，因此不以结构指标替代功能画像，也不生成个体标签。"
    },
    research: {
      exportHref: exactExportHref(anchor),
      format: "canonical_json",
      includes: [
        "精确课程与快照锚点",
        "六层证据资格状态",
        "聚合结构变化与覆盖分母",
        "证据限制与重建说明"
      ],
      excludes: [
        "论坛正文与标题",
        "学习者身份与个体画像",
        "节点、线程、事件与决定标识",
        "模型原始尝试、凭据与本机路径"
      ],
      deterministic: true
    },
    containsForumText: false,
    containsIdentity: false
  };
}

export function unavailableCourseEvidenceWorkspace(): CourseEvidenceWorkspace {
  return {
    schemaVersion: COURSE_EVIDENCE_WORKSPACE_SCHEMA_VERSION,
    status: "unavailable",
    anchor: null,
    waterfall: {
      status: "unavailable",
      headline: "证据工作区尚未就绪",
      stopAt: null,
      missing: ["需要同一课程、运行和世界快照的精确锚点"],
      stages: buildEvidenceWaterfall(null).stages
    },
    change: {
      status: "unavailable",
      baselineAsOf: null,
      currentAsOf: null,
      metrics: [
        metric("events", "事件", null, null),
        metric("threads", "讨论", null, null),
        metric("actors", "参与者", null, null),
        metric("edges", "互动关系", null, null),
        metric("support_gaps", "开放缺口", null, null)
      ],
      summary: "没有可比较的精确快照。",
      limitation: "不可把不可用解释为零变化。"
    },
    portrait: {
      status: "unavailable",
      completeUnitShare: null,
      completeUnitCount: 0,
      totalUnitCount: 0,
      observedEventShare: null,
      observedEventCount: 0,
      declaredEventCount: 0,
      unsupportedEventShare: null,
      allObservedUnitCount: 0,
      eligibleCompleteUnitCount: 0,
      unsupportedUnitCount: 0,
      unsupportedUnitShare: null,
      observationCoverage: {
        completedDetailCount: 0,
        discoveredThreadCount: 0,
        share: null
      },
      matureSupportGapCount: 0,
      compatibleRange: null,
      interactionCoverage: "unavailable",
      functionMappingStatus: "unavailable",
      summary: "课程画像尚未就绪。",
      limitation: "没有证据时不生成画像或个体判断。"
    },
    research: {
      exportHref: "",
      format: "canonical_json",
      includes: [],
      excludes: ["论坛正文与身份"],
      deterministic: true
    },
    containsForumText: false,
    containsIdentity: false
  };
}

export type CourseResearchExport = {
  schemaVersion: typeof COURSE_RESEARCH_EXPORT_SCHEMA_VERSION;
  generatedFrom: "persisted_aggregate_evidence";
  anchor: NonNullable<CourseEvidenceWorkspace["anchor"]>;
  waterfall: CourseEvidenceWorkspace["waterfall"];
  change: CourseEvidenceWorkspace["change"];
  portrait: CourseEvidenceWorkspace["portrait"];
  limitations: string[];
  reconstruction: {
    deterministic: true;
    sourceSchemaVersion: typeof COURSE_EVIDENCE_WORKSPACE_SCHEMA_VERSION;
  };
  containsForumText: false;
  containsIdentity: false;
};

export function buildCourseResearchExport(
  workspace: CourseEvidenceWorkspace
): { document: CourseResearchExport; json: string; sha256: string } {
  if (workspace.status !== "ready" || !workspace.anchor) {
    throw new Error("RESEARCH_EXPORT_EVIDENCE_UNAVAILABLE");
  }
  const document: CourseResearchExport = {
    schemaVersion: COURSE_RESEARCH_EXPORT_SCHEMA_VERSION,
    generatedFrom: "persisted_aggregate_evidence",
    anchor: workspace.anchor,
    waterfall: workspace.waterfall,
    change: workspace.change,
    portrait: workspace.portrait,
    limitations: [
      workspace.change.limitation,
      workspace.portrait.limitation,
      "该导出仅用于聚合研究核对，不支持个体诊断、因果效果或真实发布判断。"
    ],
    reconstruction: {
      deterministic: true,
      sourceSchemaVersion: COURSE_EVIDENCE_WORKSPACE_SCHEMA_VERSION
    },
    containsForumText: false,
    containsIdentity: false
  };
  const json = `${JSON.stringify(document, null, 2)}\n`;
  return {
    document,
    json,
    sha256: canonicalProtocolHash(COURSE_RESEARCH_EXPORT_SCHEMA_VERSION, {
      schemaVersion: COURSE_RESEARCH_EXPORT_SCHEMA_VERSION,
      exportJson: json
    })
  };
}
