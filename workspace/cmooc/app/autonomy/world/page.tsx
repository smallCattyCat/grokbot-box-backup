import type { Metadata } from "next";
import Link from "next/link";
import { WorldGraphExplorer } from "@/components/autonomy/world-graph-explorer";
import { CommandShell } from "@/components/ui/command-shell";
import { GlassCard } from "@/components/ui/glass-card";
import { CockpitMetricCard } from "@/components/ui/metric-card";
import { StatusPill } from "@/components/ui/status-pill";
import { autonomyDate } from "@/lib/autonomy/read-model";
import {
  buildWorldHref,
  parseWorldExplorerQuery
} from "@/lib/autonomy/world-explorer-state";
import { getAutonomyWorldReadModel } from "@/lib/autonomy/world-read-model";
import { loadOperatorCourseIdentityOverlay } from "@/lib/autonomy/operator-course-identity";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "事件参与者网络 | cMOOC 智能学伴",
  description: "查看课程运营成员、讨论结构、覆盖状态与只读证据。"
};

type CourseLabel = {
  alias: string;
  label: string;
};

/**
 * Keep the operator surface readable when a manifest only has an internal
 * alias.  The alias still travels in links and read-model lookups, but it is
 * not a useful default label for a course operator.
 */
function humanCourseLabel(course: CourseLabel): string {
  const label = course.label.trim();
  const alias = course.alias.trim();
  const readable = label.split(" · ")[0]?.trim() ?? "";

  if (readable && readable !== alias) return readable;
  if (label && label !== alias) return label;
  return "当前课程";
}

export default async function AutonomyWorldPage({
  searchParams
}: {
  searchParams?: {
    course?: string;
    snapshot?: string;
    view?: string;
    window?: string;
    focus?: string;
  };
}) {
  const explorerState = parseWorldExplorerQuery(searchParams);
  const model = await getAutonomyWorldReadModel({
    courseAlias:
      typeof searchParams?.course === "string"
        ? searchParams.course
        : null,
    snapshotId:
      typeof searchParams?.snapshot === "string"
        ? searchParams.snapshot
        : null
  });
  const snapshot = model.snapshot;
  const operatorIdentity =
    model.selectedCourse && snapshot
      ? await loadOperatorCourseIdentityOverlay({
          courseAlias: model.selectedCourse.alias,
          snapshotId: snapshot.id
        }).catch(() => null)
      : null;
  const graphReady =
    model.graph.source === "course_content_graph_v2";
  const graphIntegrityFailed =
    model.graph.readStatus === "integrity_failed";
  const coveragePartial =
    model.graph.coverageStatus === "censored" ||
    model.coverage?.complete === false;

  return (
    <div
      className="fade-in space-y-5 sm:space-y-6"
      data-testid="autonomy-world"
    >
      <CommandShell
        variant="operational"
        testId="world-masthead"
        eyebrow="课程世界 · 只读视图"
        title="事件参与者网络"
        description={
          model.selectedCourse && snapshot
            ? `课程绑定 · ${humanCourseLabel(model.selectedCourse)}　观察截至 · ${autonomyDate(new Date(snapshot.asOfAt))}`
            : model.selectedCourse
              ? `课程绑定 · ${humanCourseLabel(model.selectedCourse)}　尚无可用快照`
              : "尚无已启用课程或可用世界快照"
        }
        status={
          <>
            <StatusPill
              label={
                graphIntegrityFailed
                  ? "互动数据校验失败 · 已切换安全视图"
                  : graphReady
                    ? "互动数据已校验"
                    : "互动数据兼容视图"
              }
              tone={
                graphIntegrityFailed
                  ? "danger"
                  : graphReady
                    ? "emerald"
                    : "amber"
              }
            />
            <StatusPill
              label={
                coveragePartial
                  ? `覆盖下界 · ${model.coverage?.incompleteCommentThreadCount ?? 0} 个评论范围删失`
                  : model.coverage?.complete
                    ? "证据覆盖完整"
                    : "覆盖状态不可用"
              }
              tone={
                coveragePartial
                  ? "amber"
                  : model.coverage?.complete
                    ? "emerald"
                    : "muted"
              }
            />
          </>
        }
      >
        <div className="grid gap-4 xl:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)]">
          <section
            aria-labelledby="course-selector-title"
            className="min-w-0"
          >
            <div className="flex items-center justify-between gap-3">
              <h2
                id="course-selector-title"
                className="text-xs font-semibold text-slate-300"
              >
                课程范围
              </h2>
              <span className="font-mono text-xs text-slate-500">
                {model.courses.length} 门
              </span>
            </div>
            <nav
              aria-label="选择课程"
              className="scrollbar-quiet mt-2 flex max-w-full snap-x gap-2 overflow-x-auto pb-1"
            >
              {model.courses.map((course) => {
                const selected =
                  course.alias === model.selectedCourse?.alias;
                return (
                  <Link
                    key={course.alias}
                    href={buildWorldHref({
                      courseAlias: course.alias,
                      view: explorerState.view,
                      window: explorerState.window,
                      focus:
                        explorerState.focus === "weakest"
                          ? "weakest"
                          : null
                    })}
                    aria-current={selected ? "page" : undefined}
                    aria-label={humanCourseLabel(course)}
                    className={`min-h-11 shrink-0 snap-start rounded-md border px-3 py-2 text-xs font-semibold ${
                      selected
                        ? "border-cyan-300/60 bg-cyan-300/10 text-cyan-50"
                        : "border-slate-700 bg-slate-950/30 text-slate-300 hover:border-slate-500"
                    }`}
                  >
                    <span>{humanCourseLabel(course)}</span>
                  </Link>
                );
              })}
              {model.courses.length === 0 ? (
                <p className="text-sm text-slate-400">
                  尚无已启用课程。
                </p>
              ) : null}
            </nav>
          </section>

          <section
            aria-labelledby="snapshot-selector-title"
            className="min-w-0"
          >
            <div className="flex items-center justify-between gap-3">
              <h2
                id="snapshot-selector-title"
                className="text-xs font-semibold text-slate-300"
              >
                快照时间轴
              </h2>
              <span className="font-mono text-xs text-slate-500">
                最近 {model.snapshots.length} 次
              </span>
            </div>
            <nav
              aria-label="选择课程快照"
              className="scrollbar-quiet mt-2 flex max-w-full snap-x gap-2 overflow-x-auto pb-1"
            >
              {model.selectedCourse
                ? model.snapshots.map((item) => (
                    <Link
                      key={item.id}
                      href={buildWorldHref({
                        courseAlias: model.selectedCourse?.alias ?? "",
                        snapshotId: item.id,
                        view: explorerState.view,
                        window: explorerState.window,
                        focus:
                          explorerState.focus === "weakest"
                            ? "weakest"
                            : null
                      })}
                      aria-current={item.active ? "page" : undefined}
                      className={`min-h-11 shrink-0 snap-start rounded-md border px-3 py-2 font-mono text-xs ${
                        item.active
                          ? "border-violet-300/60 bg-violet-300/10 text-violet-50"
                          : "border-slate-700 bg-slate-950/30 text-slate-300 hover:border-slate-500"
                      }`}
                    >
                      <span className="block font-semibold">
                        {item.label}
                      </span>
                      <time className="mt-1 block" dateTime={item.asOfAt}>
                        {autonomyDate(new Date(item.asOfAt))}
                      </time>
                    </Link>
                  ))
                : null}
              {model.snapshots.length === 0 ? (
                <p className="text-sm text-slate-400">
                  当前课程还没有世界快照。
                </p>
              ) : null}
            </nav>
          </section>
        </div>
      </CommandShell>

      {model.selectionNotice ? (
        <div
          role="status"
          className="rounded-lg border border-amber-400/30 bg-amber-400/5 px-4 py-3 text-sm leading-6 text-amber-100"
        >
          {model.selectionNotice === "course_not_available"
            ? "请求的课程不在启用清单中，已切换到最近具有世界快照的课程。"
            : "请求的快照不属于当前课程或已经不可用，已回退到该课程的最新快照。"}
        </div>
      ) : null}

      <WorldGraphExplorer
        key={`${snapshot?.id ?? "empty-world"}:${explorerState.view}:${explorerState.window}:${explorerState.focus ?? "none"}`}
        model={model}
        initialState={explorerState}
        operatorIdentity={operatorIdentity}
      />

      <section
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
        aria-label="当前课程世界指标"
      >
        <CockpitMetricCard
          label="观察到的事件"
          value={snapshot?.eventCount ?? "—"}
          hint={
            snapshot
              ? `${snapshot.threadCount} 个讨论线程 · 同一事件前缀`
              : "等待课程世界快照"
          }
          tone="cyan"
        />
        <CockpitMetricCard
          label="课程结构项目"
          value={model.graph.structureFactCount}
          hint="课程、栏目、主题与资源"
          tone="emerald"
        />
        <CockpitMetricCard
          label="互动关系"
          value={`${model.community.totalActorCount} / ${model.community.totalReplyEdgeCount}`}
          hint="参与者 / 关系（当前可观察范围）"
          tone="violet"
        />
      </section>

      <GlassCard tone={coveragePartial ? "warning" : "default"}>
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(260px,0.7fr)] lg:items-start">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-slate-50">
                当前证据边界
              </h2>
              <StatusPill
                label={
                  model.graph.roleRegistryStatus === "complete"
                    ? "角色证据已就绪"
                    : "角色证据未就绪"
                }
                tone={
                  model.graph.roleRegistryStatus === "complete"
                    ? "emerald"
                    : "muted"
                }
              />
            </div>
            {graphIntegrityFailed ? (
              <p className="mt-3 max-w-4xl text-sm leading-6 text-rust">
                互动数据校验未通过，页面已拒绝使用不完整的节点、边与学习者位置，并切换到安全的只读聚合。
              </p>
            ) : coveragePartial ? (
              <p className="mt-3 max-w-4xl text-sm leading-6 text-amber-100">
                {model.coverage?.incompleteCommentThreadCount ?? 0}{" "}
                个评论范围尚未完整返回。当前互动计数只代表可观察下界，不能解释为完整课程关系或学习者状态。
              </p>
            ) : (
              <p className="mt-3 max-w-4xl text-sm leading-6 text-slate-300">
                覆盖与角色状态已随快照记录。任何学习者位置只按当前证据边界解释。
              </p>
            )}
          </div>

          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-md border border-slate-700 bg-slate-950/30 px-3 py-3">
              <dt className="text-xs text-slate-400">快照时点</dt>
              <dd className="mt-1 text-slate-100">
                {autonomyDate(
                  snapshot ? new Date(snapshot.asOfAt) : null
                )}
              </dd>
            </div>
            <div className="rounded-md border border-slate-700 bg-slate-950/30 px-3 py-3">
              <dt className="text-xs text-slate-400">
                全时段有事件连接
              </dt>
              <dd className="mt-1 font-mono text-slate-100">
                {model.graph.activeLearnerCount} /{" "}
                {model.graph.learnerNodeCount}
              </dd>
            </div>
          </dl>
        </div>
        <details className="mt-4 rounded-lg border border-slate-800/80 bg-slate-950/25 px-3 py-2">
          <summary className="cursor-pointer list-none text-xs font-semibold text-slate-400 outline-none transition hover:text-slate-200 focus-visible:ring-2 focus-visible:ring-cyan-400/70">
            核查信息
          </summary>
          <div className="mt-3 space-y-3 border-t border-slate-800 pt-3 text-xs leading-5 text-slate-500">
            <p>
              当前数据视图：{graphReady ? "互动数据已校验" : "兼容只读视图"} · schema {model.graph.schemaVersion}
            </p>
            <p>
              三层范围：{snapshot?.actorCount ?? "—"} 个事件参与者、{model.graph.actorNodeCount} 个成员并集、{model.graph.learnerNodeCount} 个具有 learner 角色证据的节点。三者不能互相替代。
            </p>
            <p className="font-mono text-[11px] text-slate-600">
              {snapshot?.worldLabel ?? "W-—"} · {snapshot?.eventSetLabel ?? "E-—"} · {snapshot?.graphLabel ?? "G-—"}
            </p>
          </div>
        </details>
      </GlassCard>

    </div>
  );
}
