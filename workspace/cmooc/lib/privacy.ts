import { createHash } from "node:crypto";

export function anonymizeLearnerName(name: string | null | undefined): string {
  const cleanName = (name || "unknown").replace(/\s+/g, " ").trim() || "unknown";
  const digest = createHash("sha256").update(cleanName).digest("hex").slice(0, 6);
  return `学习者-${digest}`;
}
