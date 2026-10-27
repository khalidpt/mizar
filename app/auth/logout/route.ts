import { logout } from "@/lib/auth/oidc";
import { serverConfig } from "@/lib/config";

// POST only, so a link or image elsewhere can't sign users out.
export async function POST() {
  return logout(serverConfig().auth);
}
