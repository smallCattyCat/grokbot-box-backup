import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const componentSource = readFileSync(
  new URL(
    "../../components/scenario-lab/CourseWorldScenarioLab.tsx",
    import.meta.url
  ),
  "utf8"
);
const cssSource = readFileSync(
  new URL(
    "../../components/scenario-lab/CourseWorldScenarioLab.module.css",
    import.meta.url
  ),
  "utf8"
);

test("Runtime Ladder 提供显式且精确绑定的 OASIS 协议预演", () => {
  assert.match(componentSource, /runtime\.role === "social_interaction_simulation"/u);
  assert.match(componentSource, /"运行 OASIS 协议预演"/u);
  assert.match(componentSource, /fetch\("\/api\/scenario-lab\/oasis-preview"/u);
  assert.match(
    componentSource,
    /const OASIS_PREVIEW_REQUEST = \{[\s\S]*?datasetRef: "p3a-2025-holdout-v1",[\s\S]*?sceneTemplateRef: "course-support-network-64-v1",[\s\S]*?seedSetRef: "courseworld-seeds-16-v1",[\s\S]*?runtimeId: "oasis_contract_reference_v1"[\s\S]*?\} as const;/u
  );
  assert.match(componentSource, /body: JSON\.stringify\(OASIS_PREVIEW_REQUEST\)/u);
  assert.match(componentSource, /cache: "no-store"/u);
});

test("OASIS 预演拥有 idle、loading、error、ready 四态", () => {
  for (const state of ["idle", "loading", "error", "ready"]) {
    assert.match(
      componentSource,
      new RegExp(`data-testid="oasis-preview-${state}"`, "u")
    );
  }
  assert.match(componentSource, /role="status" aria-live="polite"/u);
  assert.match(componentSource, /role="alert"/u);
  assert.match(componentSource, /disabled=\{oasisPreviewState\.status === "loading"\}/u);
  assert.match(componentSource, /重新运行 OASIS 协议预演/u);
});

test("ready 视图严格标明合成协议边界、原生运行时状态与场景规模", () => {
  assert.match(componentSource, /SYNTHETIC · 协议一致性预演 · 不是教育效果预测/u);
  assert.match(componentSource, /nativeOasisAvailable/u);
  assert.match(componentSource, /原生 OASIS 可用/u);
  assert.match(componentSource, /原生 OASIS 未安装 · 契约参考运行时/u);
  assert.match(componentSource, /syntheticPopulation\.agentCount/u);
  assert.match(componentSource, /syntheticPopulation\.threadCount/u);
  assert.match(componentSource, /runConfig\.seeds\.length/u);
  assert.match(componentSource, /scenePack\.arms\.length/u);
  assert.match(componentSource, /96 个合成 Agent/u);
  assert.match(componentSource, /64 个合成讨论线程/u);
  assert.match(componentSource, /16 个固定种子/u);
  assert.match(componentSource, /四个研究臂/u);
  assert.doesNotMatch(componentSource, /预测(?:提升|下降|改善)|干预有效|学习效果提升/u);
});

test("四臂表格只展示 p50 协议输出并保持可访问", () => {
  assert.match(componentSource, /report\.output\.armSummaries\.map/u);
  assert.match(componentSource, /facilitatorActionCount\.p50/u);
  assert.match(componentSource, /responseCoverageBps\.p50/u);
  assert.match(componentSource, /supportGapBps\.p50/u);
  assert.match(componentSource, /peerReplyEdgeCount\.p50/u);
  assert.match(componentSource, /动作 p50/u);
  assert.match(componentSource, /回应覆盖 p50/u);
  assert.match(componentSource, /支持缺口 p50/u);
  assert.match(componentSource, /同伴回复边 p50/u);
  assert.match(componentSource, /<caption>/u);
  assert.match(componentSource, /<th scope="col">/u);
  assert.match(componentSource, /<th scope="row">/u);
  assert.match(componentSource, /role="region" aria-label="OASIS 四臂 p50 聚合表，可横向滚动"/u);
});

test("执行边界把 sidecar 自报与沙箱证明分开，并展示短哈希", () => {
  assert.match(componentSource, /boundary\.evidenceMode/u);
  assert.match(componentSource, /boundary\.enforcementMode/u);
  assert.match(componentSource, /sidecar self-report/u);
  assert.match(componentSource, /process_contract_only/u);
  assert.match(componentSource, /不能当作操作系统沙箱证明/u);
  assert.match(componentSource, /workspaceWriteCount=0/u);
  assert.match(componentSource, /scratchWriteCount=0/u);
  assert.match(componentSource, /externalNetworkUsed=false/u);
  assert.match(componentSource, /shortHash\(report\.receipt\.receiptHash\)/u);
  assert.match(componentSource, /shortHash\(report\.reportHash\)/u);
  assert.match(componentSource, /interventionEligible = false/u);
  assert.match(componentSource, /真实动作均为 0/u);
});

test("OASIS 预演在 320px 保持触控与横向表格可用", () => {
  assert.match(
    cssSource,
    /\.lab \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);[\s\S]*?\.ready \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/u
  );
  assert.match(
    cssSource,
    /\.lab > \*,\s*\.ready > \* \{\s*min-width: 0;/u
  );
  assert.match(cssSource, /\.oasisPreviewButton \{[\s\S]*?min-height: 44px;/u);
  assert.match(cssSource, /\.oasisTableScroll \{[\s\S]*?overflow-x: auto;/u);
  assert.match(cssSource, /\.oasisTableScroll:focus-visible/u);
  assert.match(
    cssSource,
    /@media \(max-width: 639px\)[\s\S]*?\.oasisBoundaryGrid \{[\s\S]*?grid-template-columns: 1fr;/u
  );
  assert.match(cssSource, /@media \(max-width: 359px\)[\s\S]*?\.oasisSceneFacts,[\s\S]*?\.oasisBoundaryGrid \{[\s\S]*?grid-template-columns: 1fr;/u);
  assert.match(cssSource, /@media \(max-width: 359px\)[\s\S]*?\.oasisTable \{[\s\S]*?min-width: 40rem;/u);
});
