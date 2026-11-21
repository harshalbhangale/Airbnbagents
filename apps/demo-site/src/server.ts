import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { HOST_ACCOUNT, MESSAGES, PROFILES } from "./data.ts";

export { HOST_ACCOUNT, MESSAGES, PROFILES } from "./data.ts";

const COOKIE = "mw_session";

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function page(title: string, body: string, signedIn: boolean): string {
  const nav = signedIn
    ? `<a href="/feed">Home</a> <a href="/messages" id="nav-messages">Messages <b>${MESSAGES.length}</b></a> <a href="/settings">Settings</a>
       <form method="post" action="/logout" style="display:inline"><button>Sign out</button></form>`
    : `<a href="/login">Sign in</a>`;
  // Like real networks, every signed-in page pulls a preview of the inbox into a corner widget.
  const widget = signedIn
    ? `<aside id="inbox-preview"><h2>Messaging</h2><ul id="inbox-preview-list"><li>Loading…</li></ul></aside>
       <script>
         fetch("/api/messages/preview").then((r) => r.json()).then((items) => {
           document.getElementById("inbox-preview-list").innerHTML =
             items.map((m) => "<li><b>" + m.from + "</b>: " + m.body + "</li>").join("");
         }).catch(() => { document.getElementById("inbox-preview-list").innerHTML = "<li>Unavailable</li>"; });
       </script>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} · Meshwork</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{font:16px/1.5 system-ui,sans-serif;margin:0;color:#1c2330;background:#f3f5f8}
  header{background:#12355b;color:#fff;padding:12px 24px;display:flex;gap:24px;align-items:center}
  header a,header button{color:#fff;margin-right:12px;background:none;border:0;font:inherit;cursor:pointer;text-decoration:underline}
  main{max-width:720px;margin:24px auto;padding:24px;background:#fff;border-radius:8px}
  aside{position:fixed;right:16px;bottom:0;width:280px;background:#fff;border:1px solid #cfd6df;padding:12px;font-size:13px}
  label{display:block;margin:12px 0}
  .muted{color:#5b6676}
</style></head><body>
<header><strong>Meshwork</strong><nav>${nav}</nav></header>
<main>${body}</main>${widget}
</body></html>`;
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 10_000) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

export interface DemoSite {
  origin: string;
  /** Paths requested since start, for tests that check what a browser actually fetched. */
  requests: string[];
  close(): Promise<void>;
}

/** Starts Meshwork on a local port. Sessions live in memory and vanish on close. */
export async function startDemoSite(port = 0): Promise<DemoSite> {
  const sessions = new Set<string>();
  const requests: string[] = [];

  const send = (res: ServerResponse, status: number, html: string, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers });
    res.end(html);
  };
  const redirect = (res: ServerResponse, location: string, headers: Record<string, string> = {}) => {
    res.writeHead(303, { location, ...headers });
    res.end();
  };

  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      requests.push(`${req.method} ${path}`);
      const cookie = (req.headers.cookie ?? "")
        .split(";")
        .map((part) => part.trim().split("="))
        .find(([name]) => name === COOKIE)?.[1];
      const signedIn = cookie !== undefined && sessions.has(cookie);

      if (path === "/" ) return redirect(res, signedIn ? "/feed" : "/login");

      if (path === "/login" && req.method === "GET") {
        return send(
          res,
          200,
          page(
            "Sign in",
            `<h1>Sign in</h1>
             <form method="post" action="/login">
               <label>Email <input name="email" type="email" autocomplete="username" required></label>
               <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
               <button type="submit">Sign in</button>
             </form>
             ${url.searchParams.has("error") ? '<p role="alert">That email and password do not match.</p>' : ""}`,
            false,
          ),
        );
      }

      if (path === "/login" && req.method === "POST") {
        const form = await readForm(req);
        if (form.get("email") !== HOST_ACCOUNT.email || form.get("password") !== HOST_ACCOUNT.password) {
          return redirect(res, "/login?error=1");
        }
        const id = randomBytes(24).toString("hex");
        sessions.add(id);
        return redirect(res, "/feed", { "set-cookie": `${COOKIE}=${id}; HttpOnly; SameSite=Lax; Path=/` });
      }

      if (path === "/logout" && req.method === "POST") {
        if (cookie) sessions.delete(cookie);
        return redirect(res, "/login", { "set-cookie": `${COOKIE}=; Max-Age=0; Path=/` });
      }

      // Everything below needs a signed-in member, which is why an agent needs a host at all.
      if (!signedIn) {
        if (path.startsWith("/api/")) {
          res.writeHead(401, { "content-type": "application/json" });
          return res.end('{"error":"sign in required"}');
        }
        return redirect(res, "/login");
      }

      if (path === "/feed") {
        return send(
          res,
          200,
          page(
            "Home",
            `<h1>People you may know</h1><ul>${PROFILES.map(
              (p) => `<li><a href="/in/${esc(p.handle)}">${esc(p.name)}</a> <span class="muted">${esc(p.headline)}</span></li>`,
            ).join("")}</ul>`,
            true,
          ),
        );
      }

      const profileMatch = /^\/in\/([a-z0-9-]{1,40})$/.exec(path);
      if (profileMatch) {
        const profile = PROFILES.find((p) => p.handle === profileMatch[1]);
        if (!profile) return send(res, 404, page("Not found", `<h1 data-state="not-found">Member not found</h1>`, true));
        return send(
          res,
          200,
          page(
            profile.name,
            `<article data-profile="${esc(profile.handle)}">
               <h1 data-field="name">${esc(profile.name)}</h1>
               <p><span data-field="headline">${esc(profile.headline)}</span> at <span data-field="company">${esc(profile.company)}</span></p>
               <p class="muted" data-field="location">${esc(profile.location)}</p>
               <h2>About</h2><p data-field="about">${esc(profile.about)}</p>
               <h2>Contact</h2><p><a data-field="email" href="mailto:${esc(profile.email)}">${esc(profile.email)}</a></p>
             </article>`,
            true,
          ),
        );
      }

      if (path === "/messages") {
        return send(
          res,
          200,
          page(
            "Messages",
            `<h1>Messages</h1>${MESSAGES.map(
              (m) => `<section class="thread"><h2>${esc(m.subject)}</h2><p class="muted">From ${esc(m.from)}</p><p>${esc(m.body)}</p></section>`,
            ).join("")}`,
            true,
          ),
        );
      }

      if (path === "/api/messages/preview") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        return res.end(JSON.stringify(MESSAGES.map((m) => ({ from: esc(m.from), body: esc(m.body) }))));
      }

      if (path === "/settings") {
        return send(
          res,
          200,
          page("Settings", `<h1>Settings</h1><p>Signed in as <b>${esc(HOST_ACCOUNT.email)}</b></p><p>Recovery phone: 07700 900456</p>`, true),
        );
      }

      return send(res, 404, page("Not found", `<h1 data-state="not-found">Page not found</h1>`, signedIn));
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: actual } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${actual}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
