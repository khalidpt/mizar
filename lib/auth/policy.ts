import type { AuthConfig, User } from "./session";

export type Decision = { user: User } | { denied: string };

/**
 * Who may sign in, from verified ID token claims. With no allow lists, everyone the provider authenticates is let in:
 * restrict access there (app assignment). Emails and domains only count when the provider hasn't marked the email
 * unverified.
 */
export function authorize(claims: Record<string, unknown>, auth: AuthConfig): Decision {
  const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  const email = str(claims.email)?.toLowerCase();
  const user: User = {
    sub: String(claims.sub),
    email,
    name: str(claims.name) ?? str(claims.preferred_username) ?? email,
  };

  const { allowedEmails, allowedDomains, allowedGroups } = auth;
  if (!allowedEmails.length && !allowedDomains.length && !allowedGroups.length) return { user };

  if (email && claims.email_verified !== false) {
    if (allowedEmails.some((e) => e.toLowerCase() === email)) return { user };
    const domain = email.slice(email.lastIndexOf("@") + 1);
    if (allowedDomains.some((d) => d.toLowerCase().replace(/^@/, "") === domain)) return { user };
  }

  const raw = claims[auth.groupsClaim];
  const groups = Array.isArray(raw) ? raw.filter((g) => typeof g === "string") : typeof raw === "string" ? [raw] : [];
  if (groups.some((g) => allowedGroups.includes(g))) return { user };

  return { denied: `${user.name ?? user.sub} is not allowed to use this Mizar.` };
}
