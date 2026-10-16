import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const runs = await prisma.autoInterventionRun.findMany({
    include: { candidates: true },
    orderBy: { createdAt: "desc" },
    take: 20
  });
  return NextResponse.json(runs);
}
