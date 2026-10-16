import type {
  BrowserCourseRun,
  BrowserDecisionTapeEntry,
  BrowserObservation
} from "./browser-course-contracts";

/** A content-free, deterministic projection of one browser observation. */
export type BrowserInteractionMetrics = {
  coverage: "complete" | "partial" | "unknown";
  humanHumanReplies: number;
  humanAgentReplies: number;
  agentHumanReplies: number;
  unknownTargetReplies: number;
  selfReplies: number;
  humanDirectedShare: number | null;
  denominator: number;
  distinctHumanResponders: number;
  learnerPeerReplies: number;
  teacherReplies: number;
  maxHumanContinuationDepth: number;
  uniqueAuthors: number;
  roots: number;
  unansweredRoots: number;
};

export type BrowserTrajectoryStatus = "passed" | "incomplete" | "failed" | "not_evaluable";

export type BrowserTrajectoryCheck = {
  key: string;
  status: BrowserTrajectoryStatus;
  detail: string;
};

export type BrowserTrajectoryEvaluation = {
  status: BrowserTrajectoryStatus;
  checks: BrowserTrajectoryCheck[];
};

type BrowserPost = BrowserObservation["posts"][number];
type BrowserTapeEntry = BrowserDecisionTapeEntry;

function isHumanRole(role: BrowserPost["role"]): role is "learner" | "teacher" {
  return role === "learner" || role === "teacher";
}

function makeEmptyInteractionMetrics(coverage: BrowserInteractionMetrics["coverage"]): BrowserInteractionMetrics {
  return {
    coverage,
    humanHumanReplies: 0,
    humanAgentReplies: 0,
    agentHumanReplies: 0,
    unknownTargetReplies: 0,
    selfReplies: 0,
    humanDirectedShare: null,
    denominator: 0,
    distinctHumanResponders: 0,
    learnerPeerReplies: 0,
    teacherReplies: 0,
    maxHumanContinuationDepth: 0,
    uniqueAuthors: 0,
    roots: 0,
    unansweredRoots: 0
  };
}

/**
 * Derive only structural interaction counts. No post body, identity mapping,
 * causal interpretation, or inference from a missing reply enters this result.
 *
 * A reply is classified only when its parent reference resolves in this
 * observation. Missing parents remain outside all reply counts. A parent with
 * role `unknown` is resolved structurally and therefore enters the denominator
 * for a human, non-self author while remaining in the unknown-target count.
 */
export function deriveBrowserInteractionMetrics(observation: BrowserObservation | null): BrowserInteractionMetrics {
  const coverage: BrowserInteractionMetrics["coverage"] = observation === null
    ? "unknown"
    : observation.complete
      ? "complete"
      : "partial";
  const metrics = makeEmptyInteractionMetrics(coverage);
  if (!observation) return metrics;

  const posts = observation.posts;
  // The schema rejects duplicate refs. Keeping the first one also makes this
  // pure projection safe when a caller supplies an unparsed fixture.
  const byRef = new Map<string, BrowserPost>();
  for (const post of posts) if (!byRef.has(post.ref)) byRef.set(post.ref, post);

  metrics.uniqueAuthors = new Set(posts.map((post) => post.actorAlias)).size;
  const roots = posts.filter((post) => post.parentRef === null);
  metrics.roots = roots.length;
  metrics.unansweredRoots = roots.filter((root) => !posts.some((post) => post.parentRef === root.ref)).length;

  const distinctHumanResponders = new Set<string>();

  for (const post of posts) {
    if (post.parentRef === null) continue;
    const parent = byRef.get(post.parentRef);

    if (parent && post.actorAlias === parent.actorAlias) {
      metrics.selfReplies += 1;
      continue;
    }

    if (!parent) continue;
    if (parent.role === "unknown") {
      metrics.unknownTargetReplies += 1;
    }

    const sourceIsHuman = isHumanRole(post.role);
    const targetIsHuman = isHumanRole(parent.role);
    const crossPerson = post.actorAlias !== parent.actorAlias;

    if (sourceIsHuman && crossPerson) {
      metrics.denominator += 1;
      distinctHumanResponders.add(post.actorAlias);
      if (targetIsHuman) {
        metrics.humanHumanReplies += 1;
        if (post.role === "learner" && parent.role === "learner") metrics.learnerPeerReplies += 1;
      } else if (parent.role === "agent") {
        metrics.humanAgentReplies += 1;
      }
      if (post.role === "teacher") metrics.teacherReplies += 1;
    } else if (post.role === "agent" && targetIsHuman && crossPerson) {
      metrics.agentHumanReplies += 1;
    }
  }

  metrics.distinctHumanResponders = distinctHumanResponders.size;
  metrics.humanDirectedShare = metrics.denominator === 0
    ? null
    : metrics.humanHumanReplies / metrics.denominator;

  const qualifiesForHumanContinuation = (post: BrowserPost): boolean => {
    if (post.parentRef === null) return false;
    const parent = byRef.get(post.parentRef);
    return Boolean(
      parent &&
      isHumanRole(post.role) &&
      isHumanRole(parent.role) &&
      post.actorAlias !== parent.actorAlias
    );
  };

  // A cycle is not a continuation chain. Propagating a cycle marker avoids
  // treating an artificial A -> B -> A loop as a valid depth of two.
  const depthMemo = new Map<string, number | null>();
  const continuationDepth = (ref: string, visiting: Set<string>): number | null => {
    const memoized = depthMemo.get(ref);
    if (memoized !== undefined || depthMemo.has(ref)) return memoized ?? null;
    if (visiting.has(ref)) return null;
    const post = byRef.get(ref);
    if (!post || !qualifiesForHumanContinuation(post)) {
      depthMemo.set(ref, 0);
      return 0;
    }
    const nextVisiting = new Set(visiting);
    nextVisiting.add(ref);
    const parentDepth = continuationDepth(post.parentRef!, nextVisiting);
    if (parentDepth === null) {
      depthMemo.set(ref, null);
      return null;
    }
    const depth = parentDepth + 1;
    depthMemo.set(ref, depth);
    return depth;
  };

  for (const post of posts) {
    const depth = continuationDepth(post.ref, new Set());
    if (depth !== null && depth > metrics.maxHumanContinuationDepth) {
      metrics.maxHumanContinuationDepth = depth;
    }
  }

  return metrics;
}

type TrajectoryTurn = {
  phase: "patrol" | "reply_watch";
  observed: number;
  observationSerial: number;
  lastObservationDiscussions: number | null;
  decisions: number;
  decisionObservationSerial: number | null;
  watchEvents: number;
  watchObservationSerial: number | null;
  receipts: number;
  ended: boolean;
};

function tapePhase(entry: BrowserTapeEntry, fallback: BrowserCourseRun["phase"]): "patrol" | "reply_watch" {
  return entry.payload.phase === "reply_watch" || (entry.payload.phase === undefined && fallback === "reply_watch")
    ? "reply_watch"
    : "patrol";
}

function check(key: string, status: BrowserTrajectoryStatus, detail: string): BrowserTrajectoryCheck {
  return { key, status, detail };
}

/**
 * Inspect the structural evidence of an official browser-course patrol. This
 * deliberately does not verify tape hashes; that belongs to the owning store
 * or route. Recovery begins a new turn on the same tape, while an unfinished
 * earlier turn is tolerated when a later begin provides the replacement turn.
 */
export function evaluateBrowserTrajectory(run: BrowserCourseRun): BrowserTrajectoryEvaluation {
  const tape = run.tape ?? [];
  if (tape.length === 0) {
    return {
      status: "not_evaluable",
      checks: [check("tape", "not_evaluable", "没有官方 Decision Tape，无法评价巡检轨迹。")]
    };
  }

  const turns: TrajectoryTurn[] = [];
  const invalidDetails: string[] = [];
  let current: TrajectoryTurn | null = null;

  for (const entry of tape) {
    if (entry.kind === "patrol_queued" || entry.kind === "recovery") continue;
    if (entry.kind === "patrol_begin") {
      current = {
        phase: tapePhase(entry, run.phase),
        observed: 0,
        observationSerial: 0,
        lastObservationDiscussions: null,
        decisions: 0,
        decisionObservationSerial: null,
        watchEvents: 0,
        watchObservationSerial: null,
        receipts: 0,
        ended: false
      };
      turns.push(current);
      continue;
    }
    if (!current) {
      // A metadata-only prefix is not an invalid decision, but any operational
      // event before patrol_begin makes the structural sequence unusable.
      if (entry.kind !== "auth_attention" && entry.kind !== "reply_uptake" && entry.kind !== "participation_choice") {
        invalidDetails.push(`${entry.kind} 出现在 patrol_begin 之前。`);
      }
      continue;
    }
    if (current.ended) {
      if (entry.kind === "auth_attention" || entry.kind === "reply_uptake" || entry.kind === "participation_choice") continue;
      invalidDetails.push(`${entry.kind} 出现在 patrol_end 之后且没有新的 patrol_begin。`);
      continue;
    }

    switch (entry.kind) {
      case "observation":
        // A same-turn re-read is a new evidence epoch. It resets the
        // decision/watch qualification for the current snapshot while
        // deliberately preserving receipt history from earlier snapshots.
        current.observed += 1;
        current.observationSerial += 1;
        current.decisionObservationSerial = null;
        current.watchObservationSerial = null;
        current.lastObservationDiscussions = typeof entry.payload.discussions === "number" ? entry.payload.discussions : null;
        break;
      case "decision":
        if (current.observed === 0) invalidDetails.push("decision 缺少先行 observation。");
        else if (current.phase === "reply_watch") invalidDetails.push("reply_watch 回合不应写入 decision。");
        else if (current.decisionObservationSerial === current.observationSerial) invalidDetails.push("同一 observation 不应重复写入 decision。");
        else {
          current.decisions += 1;
          current.decisionObservationSerial = current.observationSerial;
        }
        break;
      case "reply_receipt":
        if (current.observed === 0 || current.decisionObservationSerial !== current.observationSerial) invalidDetails.push("reply_receipt 缺少当前 observation 的 decision 先行证据。");
        else current.receipts += 1;
        break;
      case "reply_watch":
        if (current.observed === 0) invalidDetails.push("reply_watch 缺少先行 observation。");
        else if (current.phase !== "reply_watch") invalidDetails.push("reply_watch 事件未处于 reply_watch 回合。");
        else {
          current.watchEvents += 1;
          current.watchObservationSerial = current.observationSerial;
        }
        break;
      case "patrol_end":
        if (current.observed === 0) invalidDetails.push("patrol_end 缺少先行 observation。");
        current.ended = true;
        break;
      case "auth_attention":
      case "reply_uptake":
      case "participation_choice":
        // These are additive evidence and cannot replace the core sequence.
        break;
      default:
        break;
    }
  }

  const latest = turns.at(-1);
  const hasBegin = turns.length > 0;
  const hasObservation = Boolean(latest && latest.observed > 0);
  const needsDecision = latest?.phase !== "reply_watch";
  const emptyCourseWithoutDecision = Boolean(
    latest &&
    needsDecision &&
    latest.lastObservationDiscussions === 0 &&
    run.proposals.length === 0
  );
  const hasPhaseEvidence = Boolean(latest && (
    needsDecision
      ? latest.decisionObservationSerial === latest.observationSerial || emptyCourseWithoutDecision
      : latest.watchObservationSerial === latest.observationSerial
  ));
  const hasEnd = Boolean(latest?.ended);

  // A reply-watch turn only re-reads the course. It must not reopen the
  // editor-readback obligation carried by a prior stage turn.
  const stageReadbackRequired = run.mode === "stage" && latest?.phase !== "reply_watch";
  const stageProposals = stageReadbackRequired ? run.proposals.filter((proposal) => proposal.decision === "DRAFT") : [];
  const stageComplete = !stageReadbackRequired || stageProposals.every((proposal) =>
    run.stages.some((stage) => stage.proposalId === proposal.id && stage.proposalRevision === proposal.revision && stage.cleared && !stage.submitted)
  );

  const tapeCheck = check("tape", "passed", "已发现官方 Decision Tape 证据；本函数未重复校验哈希。 ");
  const beginCheck = check("patrol_begin", hasBegin ? "passed" : "incomplete", hasBegin ? "存在至少一个官方 patrol_begin。" : "尚未发现 patrol_begin。 ");
  const observationCheck = check(
    "observation",
    hasObservation ? "passed" : run.status === "completed" ? "failed" : "incomplete",
    hasObservation ? "最新巡检回合包含 observation。" : run.status === "completed" ? "运行已结束但最新回合缺少 observation。" : "最新巡检回合尚未记录 observation。"
  );
  const phaseCheck = check(
    "decision_or_reply_watch",
    hasPhaseEvidence ? "passed" : run.status === "completed" ? "failed" : "incomplete",
    hasPhaseEvidence
      ? needsDecision
        ? emptyCourseWithoutDecision ? "最新 observation 明确记录 discussions=0，空课程无需 decision。" : "patrol 回合包含当前 observation 对应的 decision。"
        : "reply_watch 回合包含当前 observation 对应的 reply_watch 证据。"
      : needsDecision ? "最新 observation 尚未记录对应 decision。" : "最新 observation 尚未记录对应 reply_watch 证据。"
  );
  const endCheck = check(
    "patrol_end",
    hasEnd ? "passed" : run.status === "completed" ? "failed" : "incomplete",
    hasEnd ? "最新巡检回合包含 patrol_end。" : run.status === "completed" ? "运行已结束但缺少 patrol_end。" : "最新巡检回合尚未结束。"
  );
  const stageCheck = check(
    "stage_readback",
    stageComplete ? "passed" : run.status === "completed" || hasEnd ? "failed" : "incomplete",
    run.mode !== "stage"
      ? "observe 模式无需编辑器回读。"
      : !stageReadbackRequired
        ? "reply_watch 仅进行只读复扫，不重新要求原 stage 草稿回读。"
        : stageComplete
          ? "stage 模式的每条 DRAFT 都有对应回读并确认未提交。"
          : "stage 模式仍有 DRAFT 缺少对应回读，不能把结束视为完整。"
  );
  const orderCheck = check(
    "order",
    invalidDetails.length > 0 ? "failed" : "passed",
    invalidDetails.length > 0 ? invalidDetails.join(" ") : "核心事件顺序符合 patrol_begin → observation → decision/reply_watch → patrol_end。"
  );

  const checks = [tapeCheck, beginCheck, observationCheck, phaseCheck, endCheck, stageCheck, orderCheck];
  let status: BrowserTrajectoryStatus;
  if (invalidDetails.length > 0 || checks.some((item) => item.status === "failed")) status = "failed";
  else if (checks.some((item) => item.status === "incomplete")) status = "incomplete";
  else status = "passed";
  return { status, checks };
}
