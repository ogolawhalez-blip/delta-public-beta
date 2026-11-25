import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const privatePrefixes = ["/founder-console", "/founder", "/internal"];
const customerPrefixes = ["/dashboard", "/account", "/trading"];
const matches = (path: string, prefix: string) => path === prefix || path.startsWith(prefix + "/");

export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (privatePrefixes.some(prefix => matches(path, prefix))) {
    return new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  if (customerPrefixes.some(prefix => matches(path, prefix)) && !request.cookies.get("access_token")?.value) {
    const url = new URL("/login", request.url);
    url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/founder-console/:path*", "/founder/:path*", "/internal/:path*", "/dashboard/:path*", "/account/:path*", "/trading/:path*"],
};
