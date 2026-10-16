import { NextRequest, NextResponse } from "next/server";
import { requireTrustedJsonMutation } from "@/lib/http/mutation-guard";
import {
  OperatorLocatorError,
  loadOperatorCourseLocator,
  parseOperatorLocatorRequest
} from "@/lib/workbench/operator-locator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function response(body: Readonly<Record<string, unknown>>, status: number) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

export async function POST(request: NextRequest) {
  const guard = requireTrustedJsonMutation(request, "课程运营定位");
  if (guard) return guard;

  try {
    const input = parseOperatorLocatorRequest(await request.json());
    const locator = await loadOperatorCourseLocator(input);
    return response(locator, 200);
  } catch (error) {
    if (error instanceof OperatorLocatorError) {
      return response({ error: error.message, code: error.code }, error.status);
    }
    return response(
      {
        error: "课程内容与账号暂时无法读取，请稍后重试。",
        code: "OPERATOR_LOCATOR_UNAVAILABLE"
      },
      503
    );
  }
}
