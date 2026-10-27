import { type AuthConfig, clearCookie } from "./session";

/** A small sign-in status page (expired, failed, denied, signed out); also clears any pending login cookie. */
export function page(status: number, title: string, message: string, signInLink = false, auth?: AuthConfig): Response {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  if (auth?.sessionSecret) headers.append("Set-Cookie", clearCookie(auth, "login"));
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Mizar</title><style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#02040b;color:#cbd5e1;font:14px ui-monospace,monospace;padding:24px;box-sizing:border-box}
section{max-width:32rem;border:1px solid rgba(45,212,191,.25);background:rgba(2,6,23,.65);padding:24px}
h1{margin:0;font-size:18px;letter-spacing:.4em;color:#99f6e4}h2{margin:16px 0 0;font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:rgba(94,234,212,.75)}
p{color:#94a3b8;line-height:1.5}a{color:#5eead4}</style></head>
<body><section><h1>MIZAR</h1><h2>${esc(title)}</h2><p>${esc(message)}</p>${signInLink ? '<p><a href="/auth/login">Sign in</a></p>' : ""}</section></body></html>`,
    { status, headers },
  );
}

/** One log line: the error and what caused it ("invalid response encountered: unexpected ID Token nonce ..."). */
export function detail(error: unknown): string {
  const messages: string[] = [];
  for (let e: unknown = error; e instanceof Error && messages.length < 4; e = e.cause) messages.push(e.message);
  return messages.join(": ") || String(error);
}
