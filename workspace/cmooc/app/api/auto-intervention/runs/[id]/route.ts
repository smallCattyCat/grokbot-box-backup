import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

type RouteContext = {
  params: { id: string };
};

export async function GET(_request: Request, context: RouteContext) {
  const run = await prisma.autoInterventionRun.findUnique({
    where: { id: context.params.id },
    include: { candidates: { orderBy: { interventionScore: "desc" } } }
  });
  if (!run) {
    return NextResponse.json({ error: "Auto intervention run not found" }, { status: 404 });
  }
  return NextResponse.json(run);
}
