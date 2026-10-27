import type { NextRequest } from "next/server";
import { gate } from "@/lib/auth/gate";
import { serverConfig } from "@/lib/config";

// Sign-in (or the localhost-only check) in front of every page and API route; see lib/auth/gate.ts.
export function proxy(request: NextRequest) {
  return gate(request, serverConfig().auth);
}

export const config = {
  // Build assets carry no infrastructure data and must load for the sign-in pages too.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
