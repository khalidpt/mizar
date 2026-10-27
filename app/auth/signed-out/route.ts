import { connection } from "next/server";
import { signedOut } from "@/lib/auth/oidc";

export async function GET() {
  await connection();
  return signedOut();
}
