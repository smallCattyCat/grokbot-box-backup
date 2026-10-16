import { NextRequest, NextResponse } from "next/server";
import {
  isTrustedApplicationOrigin,
  requestOriginFromHeaders
} from "@/lib/http/trusted-origin";

export function middleware(request: NextRequest) {
  const requestOrigin = requestOriginFromHeaders(
    request.headers,
    request.nextUrl.protocol
  );
  if (!isTrustedApplicationOrigin(requestOrigin)) {
    return new NextResponse("Untrusted application host.", {
      status: 421,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8"
      }
    });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
