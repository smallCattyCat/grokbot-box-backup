import { z } from "zod";

/**
 * A browser page proof is a caller-supplied, replayable account of which
 * non-body items were seen on one page.  It is evidence to check; it is not a
 * claim that the remote platform itself guaranteed a complete scan.
 */
const browserRefPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;
const opaqueHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const browserPageRefSchema = z.string().regex(browserRefPattern);

const cursorPageProofSchema = z.object({
  method: z.literal("cursor"),
  queryFingerprint: opaqueHashSchema,
  pageOrdinal: z.number().int().min(1),
  itemRefs: z.array(browserPageRefSchema).max(2000),
  cursorBeforeHash: opaqueHashSchema.nullable(),
  cursorAfterHash: opaqueHashSchema.nullable(),
  mutationDetected: z.boolean().default(false)
}).strict();

const stableRefsPageProofSchema = z.object({
  method: z.literal("stable_refs"),
  queryFingerprint: opaqueHashSchema,
  pageOrdinal: z.number().int().min(1),
  itemRefs: z.array(browserPageRefSchema).max(2000),
  mutationDetected: z.boolean().default(false)
}).strict();

/** Validate only the proof fields supplied by a browser/API caller. */
export const browserPageProofSchema = z.discriminatedUnion("method", [
  cursorPageProofSchema,
  stableRefsPageProofSchema
]);

export type BrowserPageProof = z.infer<typeof browserPageProofSchema>;

export type BrowserCoveragePage = {
  itemCount: number;
  terminal: boolean;
  proof?: BrowserPageProof;
};

/** The smallest structural input accepted by the evaluator. */
export type BrowserCoverageObservation = {
  pages: readonly BrowserCoveragePage[];
  discussions?: readonly { ref: string }[];
};

export type BrowserCoverageIssue = {
  code:
    | "missing_proof"
    | "page_ordinal_mismatch"
    | "proof_method_mismatch"
    | "query_fingerprint_mismatch"
    | "duplicate_item_ref"
    | "cross_page_overlap"
    | "item_count_mismatch"
    | "terminal_not_last"
    | "cursor_chain_mismatch"
    | "mutation_detected";
  page: number;
  discussionRefs: string[];
};

export type BrowserCoverageEvaluation = {
  status: "verified" | "legacy" | "partial" | "inconsistent";
  issues: BrowserCoverageIssue[];
  verifiedPageCount: number;
  pageCount: number;
  affectedDiscussionRefs: string[];
};

function identifiableDiscussionRefs(
  itemRefs: readonly string[],
  discussions: readonly { ref: string }[] | undefined
): string[] {
  const known = discussions === undefined
    ? null
    : new Set(discussions.map((discussion) => discussion.ref));
  const refs = new Set<string>();
  for (const ref of itemRefs) {
    if (known === null || known.has(ref)) refs.add(ref);
  }
  return [...refs];
}

function duplicateRefs(itemRefs: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const ref of itemRefs) {
    if (seen.has(ref)) duplicates.add(ref);
    seen.add(ref);
  }
  return [...duplicates];
}

/**
 * Check the page-level continuity evidence attached by the observation
 * caller.  A partial set of proofs remains partial: known-good individual
 * discussion decisions can continue, while course-level completeness stays
 * unresolved for pages without proof.
 */
export function evaluateBrowserCoverage(
  observation: BrowserCoverageObservation
): BrowserCoverageEvaluation {
  const pages = observation.pages;
  const pageCount = pages.length;
  const proofCount = pages.reduce((count, page) => count + (page.proof ? 1 : 0), 0);

  if (proofCount === 0) {
    return {
      status: "legacy",
      issues: [],
      verifiedPageCount: 0,
      pageCount,
      affectedDiscussionRefs: []
    };
  }

  const issues: BrowserCoverageIssue[] = [];
  const issueKeys = new Set<string>();
  const invalidPages = new Set<number>();
  const affectedRefs = new Set<string>();

  const refsForPage = (pageNumber: number): string[] => {
    const proof = pages[pageNumber - 1]?.proof;
    return identifiableDiscussionRefs(proof?.itemRefs ?? [], observation.discussions);
  };

  const addIssue = (
    code: BrowserCoverageIssue["code"],
    page: number,
    itemRefs: readonly string[] = refsForPage(page)
  ): void => {
    const discussionRefs = identifiableDiscussionRefs(itemRefs, observation.discussions);
    const key = `${code}:${page}:${discussionRefs.join(",")}`;
    if (issueKeys.has(key)) return;
    issueKeys.add(key);
    invalidPages.add(page);
    for (const ref of discussionRefs) affectedRefs.add(ref);
    issues.push({ code, page, discussionRefs });
  };

  // These checks are meaningful for each independently supplied proof, even
  // when another page has no proof and the overall result must remain partial.
  for (let index = 0; index < pageCount; index += 1) {
    const page = pages[index]!;
    const pageNumber = index + 1;
    const proof = page.proof;
    if (!proof) {
      addIssue("missing_proof", pageNumber, []);
      continue;
    }

    const repeated = duplicateRefs(proof.itemRefs);
    if (repeated.length > 0) addIssue("duplicate_item_ref", pageNumber, repeated);
    if (page.itemCount !== proof.itemRefs.length) {
      addIssue("item_count_mismatch", pageNumber);
    }
    if (proof.mutationDetected) addIssue("mutation_detected", pageNumber);
  }

  const completeProof = proofCount === pageCount;
  if (completeProof) {
    const firstProof = pages[0]!.proof!;
    const expectedQuery = firstProof.queryFingerprint;
    const expectedMethod = firstProof.method;
    const seenRefs = new Map<string, number>();

    for (let index = 0; index < pageCount; index += 1) {
      const page = pages[index]!;
      const pageNumber = index + 1;
      const proof = page.proof!;

      if (proof.pageOrdinal !== pageNumber) {
        addIssue("page_ordinal_mismatch", pageNumber);
      }
      if (proof.method !== expectedMethod) {
        addIssue("proof_method_mismatch", pageNumber);
      }
      if (proof.queryFingerprint !== expectedQuery) {
        addIssue("query_fingerprint_mismatch", pageNumber);
      }
      if (page.terminal !== (pageNumber === pageCount)) {
        addIssue("terminal_not_last", pageNumber);
      }

      for (const ref of proof.itemRefs) {
        const previousPage = seenRefs.get(ref);
        if (previousPage !== undefined) {
          addIssue("cross_page_overlap", pageNumber, [ref]);
        } else {
          seenRefs.set(ref, pageNumber);
        }
      }
    }

    if (expectedMethod === "cursor") {
      for (let index = 0; index < pageCount; index += 1) {
        const pageNumber = index + 1;
        const proof = pages[index]!.proof!;
        if (proof.method !== "cursor") continue;
        const previousProof = index > 0 ? pages[index - 1]!.proof! : undefined;
        if (previousProof && previousProof.method !== "cursor") continue;
        const firstPageHasPrevious = index === 0 && proof.cursorBeforeHash !== null;
        const linkBreaks = index > 0 && proof.cursorBeforeHash !== previousProof!.cursorAfterHash;
        const nonterminalHasNoNext = index < pageCount - 1 && proof.cursorAfterHash === null;
        const terminalHasNext = index === pageCount - 1 && proof.cursorAfterHash !== null;
        if (firstPageHasPrevious || linkBreaks || nonterminalHasNoNext || terminalHasNext) {
          addIssue("cursor_chain_mismatch", pageNumber);
        }
      }
    }
  }

  const status = completeProof
    ? (issues.length === 0 ? "verified" : "inconsistent")
    : "partial";
  const verifiedPageCount = pages.reduce(
    (count, page, index) => count + (page.proof && !invalidPages.has(index + 1) ? 1 : 0),
    0
  );

  return {
    status,
    issues,
    verifiedPageCount,
    pageCount,
    affectedDiscussionRefs: [...affectedRefs]
  };
}
