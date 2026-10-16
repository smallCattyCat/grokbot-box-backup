import { generateTextWithFallback } from "./client";
import type { ChatMessage } from "./siliconflow";
export { generateJson } from "./client";

export async function generateWithOptionalRealLlm(messages: ChatMessage[], fallback: string): Promise<string> {
  return generateTextWithFallback(messages, fallback);
}
