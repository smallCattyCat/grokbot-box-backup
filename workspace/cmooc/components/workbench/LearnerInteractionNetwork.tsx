"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowSquareOut } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { Graph } from "@phosphor-icons/react/dist/csr/Graph";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { UsersThree } from "@phosphor-icons/react/dist/csr/UsersThree";
import type {
  OperatorLearnerNetworkNode,
  OperatorOpportunity,
  OperatorWorkspaceReadModel
} from "@/lib/workbench/operator-read-model";
import styles from "./Workbench.module.css";

const COMMUNITY_COLORS = ["#1bb39b", "#3388ff", "#36b96f"] as const;

function coverageLabel(
  coverage: OperatorWorkspaceReadModel["learnerNetwork"]["coverageStatus"]
): string {
  if (coverage === "complete") return "覆盖完整";
  if (coverage === "lower_bound") return "覆盖下界";
  return "覆盖待同步";
}

function formatDate(value: string | null): string {
  if (!value) return "尚无快照";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间待同步";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

export function LearnerInteractionNetwork({
  operator,
  attachedContextRef,
  onAttach,
  onAttachNode,
  onCreateGenericTask
}: {
  operator: OperatorWorkspaceReadModel;
  attachedContextRef: string;
  onAttach: (opportunity: OperatorOpportunity) => void;
  onAttachNode: (node: OperatorLearnerNetworkNode) => void;
  onCreateGenericTask: () => void;
}) {
  const network = operator.learnerNetwork;
  const [minimumWeight, setMinimumWeight] = useState(1);
  const [showCrossCommunity, setShowCrossCommunity] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [selectedNodeId, setSelectedNodeId] = useState(
    network.nodes[0]?.id ?? ""
  );
  const nodeById = useMemo(
    () => new Map(network.nodes.map((node) => [node.id, node])),
    [network.nodes]
  );
  const visibleEdges = useMemo(
    () =>
      network.edges.filter(
        (edge) =>
          edge.weight >= minimumWeight &&
          (showCrossCommunity || !edge.crossCommunity)
      ),
    [minimumWeight, network.edges, showCrossCommunity]
  );
  const connectedNodeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const edge of visibleEdges) {
      ids.add(edge.sourceId);
      ids.add(edge.targetId);
    }
    return ids;
  }, [visibleEdges]);
  const selectedNode =
    nodeById.get(selectedNodeId) ?? network.nodes[0] ?? null;
  const currentOpportunity =
    operator.opportunities.find(
      (item) => item.contextRef === attachedContextRef
    ) ?? operator.opportunities[0] ?? null;

  const createTask = () => selectedNode
    ? onAttachNode(selectedNode)
    : currentOpportunity
      ? onAttach(currentOpportunity)
      : onCreateGenericTask();

  return (
    <section className={styles.networkWorkspace} aria-labelledby="network-heading">
      <header className={styles.networkHeader}>
        <div className={styles.networkTitleBlock}>
          <div className={styles.networkTitleLine}>
            <Graph size={22} weight="duotone" />
            <h1 id="network-heading">学习者互动网络</h1>
            <span className={styles.windowBadge}>截至快照</span>
          </div>
          <p>
            匿名学习者之间的直接回复关系。节点大小表示互动量，连线粗细表示频次，箭头表示方向。
          </p>
        </div>
        <div className={styles.networkMetrics} aria-label="互动网络摘要">
          <div><span>学习者</span><strong>{network.totalLearnerCount}</strong></div>
          <div><span>直接互动</span><strong>{network.directInteractionCount}</strong></div>
          <div><span>互动社群</span><strong>{network.communityCount}</strong></div>
        </div>
        <div className={styles.privacyNote}>
          <CheckCircle size={16} weight="fill" />
          <span>匿名化节点 · 仅显示关系结构 · 非学习效果评价</span>
        </div>
      </header>

      <div className={styles.networkToolbar} aria-label="网络筛选与证据状态">
        <span className={styles.snapshotFact}>快照 {formatDate(operator.scheduledFor)}</span>
        <div className={styles.segmentedControl} aria-label="最小互动权重">
          {[1, 2, 4].map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={minimumWeight === value}
              onClick={() => setMinimumWeight(value)}
            >
              {value === 1 ? "全部关系" : `${value}+ 次`}
            </button>
          ))}
        </div>
        <label className={styles.compactToggle}>
          <input
            type="checkbox"
            checked={showCrossCommunity}
            onChange={(event) => setShowCrossCommunity(event.target.checked)}
          />
          <span>跨群连接</span>
        </label>
        <label className={styles.compactToggle}>
          <input
            type="checkbox"
            checked={showLabels}
            onChange={(event) => setShowLabels(event.target.checked)}
          />
          <span>匿名标签</span>
        </label>
        <span className={styles.coverageNote} data-status={network.coverageStatus}>
          {coverageLabel(network.coverageStatus)}
          {network.truncated ? " · 显示高关联节点" : ""}
        </span>
      </div>

      <div className={styles.networkBody}>
        <div className={styles.networkCanvasShell}>
          {network.status === "ready" && network.nodes.length > 0 ? (
            <>
              <svg
                className={styles.networkCanvas}
                viewBox="0 0 960 620"
                role="img"
                aria-labelledby="learner-network-svg-title learner-network-svg-description"
              >
                <title id="learner-network-svg-title">匿名学习者互动社会网络</title>
                <desc id="learner-network-svg-description">
                  当前课程快照中学习者之间的直接回复关系。选择节点可以查看聚合互动指标。
                </desc>
                <defs>
                  <marker
                    id="learner-network-arrow"
                    viewBox="0 0 10 10"
                    refX="8"
                    refY="5"
                    markerWidth="4"
                    markerHeight="4"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
                  </marker>
                </defs>
                {visibleEdges.map((edge) => {
                  const source = nodeById.get(edge.sourceId);
                  const target = nodeById.get(edge.targetId);
                  if (!source || !target) return null;
                  const weak = edge.weakBridge;
                  return (
                    <line
                      key={edge.id}
                      x1={source.x}
                      y1={source.y}
                      x2={target.x}
                      y2={target.y}
                      stroke={weak ? "#ffaa00" : COMMUNITY_COLORS[source.community % COMMUNITY_COLORS.length]}
                      strokeWidth={Math.min(5.5, 0.8 + Math.sqrt(Math.max(1, edge.weight)) * 0.75)}
                      strokeDasharray={weak ? "8 7" : edge.completeness === "censored" ? "3 5" : undefined}
                      opacity={weak ? 0.95 : edge.crossCommunity ? 0.58 : 0.44}
                      markerEnd="url(#learner-network-arrow)"
                      vectorEffect="non-scaling-stroke"
                    />
                  );
                })}
                {network.nodes.map((node) => {
                  const selected = node.id === selectedNode?.id;
                  const visible = connectedNodeIds.size === 0 || connectedNodeIds.has(node.id);
                  const color = COMMUNITY_COLORS[node.community % COMMUNITY_COLORS.length];
                  return (
                    <g
                      key={node.id}
                      className={styles.networkNode}
                      data-selected={selected}
                      opacity={visible ? 1 : 0.22}
                      onClick={() => setSelectedNodeId(node.id)}
                      role="button"
                      tabIndex={0}
                      aria-label={`${node.label}，${node.replyCount} 次回复，${node.distinctPeerCount} 个相邻学习者`}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelectedNodeId(node.id);
                        }
                      }}
                    >
                      {selected ? (
                        <circle
                          cx={node.x}
                          cy={node.y}
                          r={node.radius + 8}
                          fill="none"
                          stroke="#e8e8e8"
                          strokeWidth="1.2"
                          opacity="0.92"
                        />
                      ) : null}
                      <circle
                        cx={node.x}
                        cy={node.y}
                        r={node.radius}
                        fill={color}
                        fillOpacity={selected ? 1 : 0.82}
                        stroke={selected ? "#ffffff" : color}
                        strokeWidth={selected ? 2 : 1}
                      />
                      {showLabels && (selected || node.radius >= 10) ? (
                        <text
                          x={node.x}
                          y={node.y + 4}
                          textAnchor="middle"
                          fill="#f4f6f8"
                          fontSize={selected ? 13 : 10}
                          fontFamily="Cascadia Mono, Consolas, monospace"
                          fontWeight={selected ? 700 : 600}
                          pointerEvents="none"
                        >
                          {node.label}
                        </text>
                      ) : null}
                    </g>
                  );
                })}
              </svg>
              {network.weakBridgeCount > 0 ? (
                <div className={styles.bridgeAnnotation}>
                  <strong>跨群互动断点</strong>
                  <span>潜在桥接者 · 待研判</span>
                </div>
              ) : null}
              <div className={styles.canvasTools} aria-label="画布说明">
                <button type="button" title="定位当前节点" onClick={() => selectedNode && setSelectedNodeId(selectedNode.id)}>
                  <MagnifyingGlass size={17} />
                </button>
                <Link href="/autonomy/world" title="打开完整关系证据">
                  <ArrowSquareOut size={17} />
                </Link>
              </div>
            </>
          ) : (
            <div className={styles.networkEmpty}>
              <UsersThree size={34} weight="duotone" />
              <strong>当前快照还没有可绘制的学习者互动关系</strong>
              <p>角色证据或匿名回复边就绪后，这里会生成真实关系结构，不使用演示节点填充。</p>
            </div>
          )}
        </div>

      </div>

      <div className={styles.networkSelectionBar} aria-live="polite">
        <div>
          <span>当前选择</span>
          <strong>{selectedNode?.label ?? "课程网络"}</strong>
          <p>
            {selectedNode
              ? `${selectedNode.replyCount} 次回复 · ${selectedNode.distinctPeerCount} 个相邻学习者`
              : "等待选择匿名节点"}
          </p>
        </div>
        <div className={styles.selectionEvidence}>
          <span>{network.visibleLearnerCount}/{network.totalLearnerCount} 可见</span>
          <span>{network.weakBridgeCount} 个弱连接</span>
          {currentOpportunity ? (
            <button type="button" onClick={() => onAttach(currentOpportunity)}>
              附加本轮决定
            </button>
          ) : null}
        </div>
        <div className={styles.selectionActions}>
          <button type="button" className={styles.primaryAction} onClick={createTask}>
            加入控制台上下文
          </button>
          <Link href="/autonomy/world" className={styles.secondaryAction}>
            查看关系证据
          </Link>
        </div>
      </div>
    </section>
  );
}
