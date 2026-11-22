import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { CAPABILITIES } from "@agentbnb/protocol";
import type { HostApp } from "../app.ts";

const asset = (name: string) => readFileSync(new URL(`./public/${name}`, import.meta.url));
const COOKIE = "agentbnb_dashboard";

export interface Dashboard {
  /** Open this once: it carries the sign-in token and swaps it for a cookie. */
  url: string;
  origin: string;
  close(): Promise<void>;
}

class BadRequest extends Error {}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 20_000) throw new BadRequest("body too large");
    chunks.push(chunk as Buffer);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BadRequest("body is not JSON");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new BadRequest("body must be an object");
  return body as Record<string, unknown>;
}

function state(app: HostApp) {
  const { worker } = app;
  const policy = worker.policy;
  const offers = worker.offers;
  const entries = worker.auditEntries();
  const last = entries[entries.length - 1];
  return {
    workerKeyId: worker.listing().workerKeyId,
    site: worker.siteOrigin,
    paused: worker.paused,
    // A task that just bounced off the sign-in page is fresher news than the last explicit check.
    signedIn: app.signedIn && last?.reason !== "not_signed_in",
    marketplace: { url: app.marketplaceUrl, status: app.marketplaceStatus },
    payoutAddress: app.payoutAddress,
    capabilities: Object.values(CAPABILITIES).map((spec) => {
      const rule = policy.capabilities[spec.id];
      const offer = offers.find((o) => o.kind === "automation_session" && o.capability === spec.id);
      return {
        id: spec.id,
        title: spec.title,
        description: spec.description,
        enabled: rule?.enabled ?? false,
        priceMicroUsd: offer && offer.kind === "automation_session" ? offer.pricePerSession : null,
        fields: Object.entries(spec.fields).map(([name, field]) => ({
          name,
          label: field.label,
          sensitivity: field.sensitivity,
          allowed: field.sensitivity !== "blocked" && (rule?.allowFields.includes(name) ?? false),
        })),
      };
    }),
    earnings: worker.earnings(),
    activity: entries.slice(-50).reverse(),
    activityTotal: entries.length,
    auditIntact: worker.auditIntact(),
    guard: worker.guardStats(),
  };
}

/**
 * The host's control panel, served to their own browser only. It can change
 * privacy rules, so it is locked down: loopback only, a one-time token traded
 * for a same-site cookie, a fixed Host header (which defeats DNS rebinding),
 * and an Origin check on every change (which defeats requests forged by other
 * pages open in the same browser).
 */
export async function startDashboard(app: HostApp, options: { port?: number } = {}): Promise<Dashboard> {
  const token = randomBytes(32).toString("base64url");
  const files = {
    "/": { type: "text/html; charset=utf-8", body: asset("index.html") },
    "/app.js": { type: "text/javascript; charset=utf-8", body: asset("app.js") },
    "/app.css": { type: "text/css; charset=utf-8", body: asset("app.css") },
  } as const;
  let hosts: string[] = [];
  let origins: string[] = [];

  const baseHeaders = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  };
  const send = (res: ServerResponse, status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}) => {
    res.writeHead(status, { ...baseHeaders, "content-type": type, ...extra });
    res.end(body);
  };
  const json = (res: ServerResponse, status: number, body: unknown) => send(res, status, "application/json", JSON.stringify(body));

  const hasSession = (req: IncomingMessage) => {
    const value = (req.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim().split("="))
      .find(([name]) => name === COOKIE)?.[1];
    if (!value) return false;
    const given = Buffer.from(value);
    const expected = Buffer.from(token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  async function change(path: string, body: Record<string, unknown>): Promise<unknown> {
    const { worker } = app;
    if (path === "/api/pause") {
      if (typeof body.paused !== "boolean") throw new BadRequest("paused must be true or false");
      if (body.paused) worker.pause();
      else worker.resume();
      app.announce();
      return { paused: worker.paused };
    }
    if (path === "/api/policy") {
      const { capability, enabled, allowFields } = body;
      if (typeof capability !== "string" || !Object.hasOwn(CAPABILITIES, capability)) throw new BadRequest("unknown capability");
      if (typeof enabled !== "boolean") throw new BadRequest("enabled must be true or false");
      if (!Array.isArray(allowFields) || !allowFields.every((f) => typeof f === "string")) throw new BadRequest("allowFields must be a list of names");
      const policy = worker.policy;
      policy.capabilities[capability] = { enabled, allowFields: [...new Set(allowFields as string[])] };
      try {
        worker.setPolicy(policy);
      } catch (error) {
        throw new BadRequest(error instanceof Error ? error.message : "rules were refused");
      }
      app.announce();
      return { ok: true };
    }
    if (path === "/api/price") {
      const { capability, priceUsd } = body;
      if (typeof capability !== "string" || !Object.hasOwn(CAPABILITIES, capability)) throw new BadRequest("unknown capability");
      if (typeof priceUsd !== "string" || !/^\d{1,5}(\.\d{1,6})?$/.test(priceUsd)) throw new BadRequest("price must be a dollar amount such as 0.02");
      const [whole, fraction = ""] = priceUsd.split(".");
      const micro = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0"));
      const offers = worker.offers.filter((o) => !(o.kind === "automation_session" && o.capability === capability));
      try {
        worker.setOffers([...offers, { kind: "automation_session", capability, pricePerSession: micro }]);
      } catch (error) {
        throw new BadRequest(error instanceof Error ? error.message : "price was refused");
      }
      app.announce();
      return { ok: true };
    }
    if (path === "/api/payout") {
      if (typeof body.address !== "string") throw new BadRequest("address is required");
      try {
        app.setPayoutAddress(body.address);
      } catch {
        throw new BadRequest("that is not a valid payout address");
      }
      return { ok: true };
    }
    if (path === "/api/sign-in") {
      const { email, password } = body;
      if (typeof email !== "string" || typeof password !== "string" || email.length > 200 || password.length > 200) {
        throw new BadRequest("email and password are required");
      }
      // Typed straight into the site's own form inside the isolated browser. Not stored, not logged.
      return { signedIn: await app.signIn(email, password) };
    }
    if (path === "/api/recheck-sign-in") return { signedIn: await app.recheckSignIn() };
    return undefined;
  }

  const server = createServer((req, res) => {
    Promise.resolve()
      .then(async () => {
        // Only ever answer to the exact loopback name and port we listen on.
        if (!hosts.includes(req.headers.host ?? "")) return send(res, 403, "text/plain", "Forbidden");
        const url = new URL(req.url ?? "/", origins[0]);
        const path = url.pathname;

        if (req.method === "GET" && path === "/" && url.searchParams.has("token")) {
          const given = Buffer.from(url.searchParams.get("token") ?? "");
          const expected = Buffer.from(token);
          if (given.length !== expected.length || !timingSafeEqual(given, expected)) return send(res, 403, "text/plain", "Forbidden");
          return send(res, 303, "text/plain", "", {
            location: "/",
            "set-cookie": `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`,
          });
        }
        if (!hasSession(req)) {
          return send(res, 401, "text/plain", "Open the dashboard using the link the agentbnb host app printed when it started.");
        }

        if (req.method === "GET") {
          if (path in files) {
            const file = files[path as keyof typeof files];
            return send(res, 200, file.type, file.body);
          }
          if (path === "/api/state") return json(res, 200, state(app));
          return send(res, 404, "text/plain", "Not found");
        }

        if (req.method !== "POST") return send(res, 405, "text/plain", "Method not allowed");
        if (!origins.includes(req.headers.origin ?? "")) return send(res, 403, "text/plain", "Forbidden");
        if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "send JSON" });
        try {
          const result = await change(path, await readJson(req));
          return result === undefined ? send(res, 404, "text/plain", "Not found") : json(res, 200, result);
        } catch (error) {
          if (error instanceof BadRequest) return json(res, 400, { error: error.message });
          throw error;
        }
      })
      .catch(() => {
        if (!res.headersSent) json(res, 500, { error: "something went wrong" });
        else res.end();
      });
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  origins = hosts.map((host) => `http://${host}`);

  return {
    url: `${origins[0]}/?token=${token}`,
    origin: origins[0]!,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
