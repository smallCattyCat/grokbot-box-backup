import { NextResponse } from "next/server";
import { getLlmRuntimeStatus } from "@/lib/llm/client";

export async function GET() {
  return NextResponse.json(getLlmRuntimeStatus());
}
