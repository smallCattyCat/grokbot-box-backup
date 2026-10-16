import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";

const cardSchema = z.object({ id: z.string(), title: z.string(), source_observation: z.string(),
  requires: z.array(z.string()), excludes: z.array(z.string()), unknowns: z.array(z.string()),
  method_steps: z.array(z.string()), proposed_followup: z.string(), transfer_note: z.string(),
  source_ids: z.array(z.string()), status: z.literal("external_candidate_not_locally_validated"), actual_run_refs: z.array(z.string()).length(0)
});
const sourceSchema = z.object({ id: z.string(), title: z.string(), url: z.string().url(),
  license: z.string(), license_evidence: z.string(), verification_scope: z.string(), checked_on: z.string()
}).passthrough();
export async function searchPublicPractice(query: string, limit = 5, root = process.cwd()) {
  const folder = path.join(root, "resources", "public-practice");
  const manifest = JSON.parse(await readFile(path.join(folder, "manifest.json"), "utf8"));
  const read = async (name: string) => {
    const raw = await readFile(path.join(folder, name));
    if (createHash("sha256").update(raw).digest("hex") !== manifest.files[name]) throw new Error("PUBLIC_LIBRARY_INTEGRITY_FAILED");
    return JSON.parse(raw.toString("utf8"));
  };
  const cards = z.array(cardSchema).parse(await read("cards.json"));
  const sources = z.array(sourceSchema).parse(await read("sources.json"));
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const ranked = cards.map(card => {
    const related = sources.filter(source => card.source_ids.includes(source.id));
    const text = JSON.stringify({ card, related }).toLowerCase();
    return { card, sources: related, score: terms.reduce((total, term) => total + (text.includes(term) ? 1 : 0), 0) };
  }).filter(item => terms.length === 0 || item.score > 0).sort((a, b) => b.score - a.score || a.card.id.localeCompare(b.card.id));
  return { schemaVersion: "cmooc-public-practice-search.v1", retrieval: "lexical", status: "external_candidate_not_locally_validated",
    totalCards: cards.length, totalSources: sources.length, matched: ranked.length,
    productionImported: false, courseApprovalGranted: false, results: ranked.slice(0, Math.max(1, Math.min(limit, 20))) };
}
