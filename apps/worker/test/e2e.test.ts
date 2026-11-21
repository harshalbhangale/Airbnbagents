import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOST_ACCOUNT, MESSAGES, startDemoSite, type DemoSite } from "@agentbnb/demo-site";
import { openResult, sealRequest } from "@agentbnb/protocol";
import { HostWorker } from "../src/index.ts";

let site: DemoSite;
let worker: HostWorker;
let dataDir: string;

/** Plays the agent: encrypt, hand to the worker, verify the receipt, decrypt. */
async function rent(capability: string, input: Record<string, unknown>) {
  const listing = worker.listing();
  const prepared = await sealRequest({
    capability,
    input,
    workerPublicKey: listing.encryptionKey,
    workerKeyId: listing.workerKeyId,
  });
  const output = await worker.handle(prepared.request);
  const opened = await openResult({
    result: JSON.parse(JSON.stringify(output.wire)),
    request: prepared.request,
    replyKeys: prepared.replyKeys,
    workerSigningKey: listing.signingKey,
  });
  return { wire: output.wire, ...opened };
}

/** Every string that belongs to the host's private inbox or settings. */
const PRIVATE_STRINGS = [...MESSAGES.flatMap((m) => [m.subject, m.body]), "07700 900456", HOST_ACCOUNT.password];

beforeAll(async () => {
  site = await startDemoSite();
  dataDir = mkdtempSync(join(tmpdir(), "agentbnb-e2e-"));
  worker = await HostWorker.start({ dataDir, siteOrigin: site.origin });
});

afterAll(async () => {
  await worker?.close();
  await site?.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe("host worker against the demo site", () => {
  it("reports that the profile is not signed in yet", async () => {
    const result = await rent("profile.read", { handle: "jordan-lee" });
    expect([result.status, result.reason]).toEqual(["error", "not_signed_in"]);
  });

  it("refuses a wrong password and accepts the right one", async () => {
    expect(await worker.signIn(HOST_ACCOUNT.email, "wrong")).toBe(false);
    expect(await worker.signIn(HOST_ACCOUNT.email, HOST_ACCOUNT.password)).toBe(true);
  });

  it("returns the allowed profile fields from the signed-in session", async () => {
    const result = await rent("profile.read", { handle: "jordan-lee" });
    expect(result.status).toBe("ok");
    expect(result.body?.data).toEqual({
      name: "Jordan Lee",
      headline: "Software Engineer",
      company: "Example Labs",
      about: "Builds data pipelines and mentors new engineers. Interested in distributed systems and good coffee.",
    });
    expect(result.body?.withheld).toEqual(
      expect.arrayContaining([
        { field: "location", reason: "host_policy" },
        { field: "email", reason: "host_policy" },
      ]),
    );
  });

  it("never loads the inbox preview that the page itself tries to fetch", async () => {
    await expect.poll(() => worker.guardStats().blockedPaths).toContain("/api/messages/preview");
    const inboxHits = site.requests.filter((r) => r.includes("/messages"));
    expect(inboxHits).toEqual([]);
  });

  it("denies a request for private messages without touching the site", async () => {
    const before = site.requests.length;
    const result = await rent("messages.read", { thread: "latest" });
    expect([result.status, result.reason]).toEqual(["denied", "capability_blocked"]);
    expect(site.requests.length).toBe(before);
  });

  it("rejects attempts to steer the browser somewhere else", async () => {
    const before = site.requests.length;
    for (const input of [
      { handle: "../messages" },
      { handle: "jordan-lee/../../messages" },
      { handle: "jordan-lee", url: `${site.origin}/messages` },
      { handle: `${site.origin}/settings` },
    ]) {
      const result = await rent("profile.read", input);
      expect([result.status, result.reason]).toEqual(["rejected", "invalid_input"]);
    }
    expect(site.requests.length).toBe(before);
  });

  it("throws away a profile that carries contact details in free text", async () => {
    const result = await rent("profile.read", { handle: "sam-okafor" });
    expect([result.status, result.reason]).toEqual(["withheld", "output_scan_failed"]);
    expect(result.body?.data).toBeNull();
    expect(result.body?.detectors).toEqual(expect.arrayContaining(["about:email", "about:phone"]));
  });

  it("throws away a profile written to hijack the agent", async () => {
    const result = await rent("profile.read", { handle: "alex-rivera" });
    expect([result.status, result.reason]).toEqual(["withheld", "output_scan_failed"]);
    expect(result.body?.detectors).toContain("about:prompt_injection");
    // The agent can still get the safe fields by not asking for the free-text one.
    const retry = await rent("profile.read", { handle: "alex-rivera", fields: ["name", "headline", "company"] });
    expect(retry.body?.data).toEqual({ name: "Alex Rivera", headline: "Growth Marketer", company: "Brightside Media" });
  });

  it("reports a member that does not exist", async () => {
    const result = await rent("profile.read", { handle: "nobody-here" });
    expect([result.status, result.reason]).toEqual(["error", "not_found"]);
  });

  it("applies a rule change straight away and remembers it", async () => {
    worker.setPolicy({
      capabilities: { "profile.read": { enabled: true, allowFields: ["name", "email"] } },
      maxTasksPerMinute: 30,
    });
    const result = await rent("profile.read", { handle: "priya-nair" });
    expect(result.body?.data).toEqual({ name: "Priya Nair", email: "priya@northwind.test" });
    expect(JSON.parse(readFileSync(join(dataDir, "policy.json"), "utf8")).capabilities["profile.read"].allowFields).toEqual(["name", "email"]);
  });

  it("stops immediately when the host hits the kill switch", async () => {
    worker.pause();
    const result = await rent("profile.read", { handle: "jordan-lee" });
    expect([result.status, result.reason]).toEqual(["denied", "host_paused"]);
    worker.resume();
  });

  it("never let any private content out, in results or in the worker's own records", async () => {
    const entries = worker.auditEntries();
    expect(worker.auditIntact()).toBe(true);
    expect(entries.length).toBeGreaterThan(10);

    const records = [JSON.stringify(entries), readFileSync(join(dataDir, "audit.jsonl"), "utf8"), readFileSync(join(dataDir, "policy.json"), "utf8")].join("\n");
    for (const secret of PRIVATE_STRINGS) expect(records).not.toContain(secret);
    expect(records).not.toContain("Jordan Lee");

    // The worker's key file is private to the host's user account.
    expect(statSync(join(dataDir, "worker-keys.json")).mode & 0o077).toBe(0);
    expect(readdirSync(dataDir).sort()).toEqual(["audit.jsonl", "browser-profile", "policy.json", "worker-keys.json"]);
  });
});
