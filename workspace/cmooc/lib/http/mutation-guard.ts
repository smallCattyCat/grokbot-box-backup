import { NextRequest, NextResponse } from "next/server";
import {
  isTrustedApplicationOrigin,
  requestOriginFromHeaders
} from "@/lib/http/trusted-origin";

export function requireTrustedJsonMutation(
  request: NextRequest,
  actionLabel: string
): NextResponse | null {
  const mediaType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    return NextResponse.json(
      { error: `${actionLabel}请求必须使用 JSON。` },
      { status: 415 }
    );
  }

  const originHeader = request.headers.get("origin");
  let origin: string;
  try {
    origin = originHeader ? new URL(originHeader).origin : "";
  } catch {
    origin = "";
  }
  const requestOrigin = requestOriginFromHeaders(
    request.headers,
    request.nextUrl.protocol
  );
  if (!origin || !requestOrigin || origin !== requestOrigin) {
    return NextResponse.json(
      { error: `${actionLabel}只能从当前系统页面发起。` },
      { status: 403 }
    );
  }

  if (!isTrustedApplicationOrigin(requestOrigin)) {
    return NextResponse.json(
      { error: `${actionLabel}请求的系统地址不在本机或已配置可信地址中。` },
      { status: 403 }
    );
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") {
    return NextResponse.json(
      { error: `${actionLabel}请求不是当前页面的同源操作。` },
      { status: 403 }
    );
  }
  return null;
}
