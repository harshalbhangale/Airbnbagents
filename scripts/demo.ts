/**
 * Runs the whole host-side flow on one machine, with no payment and no
 * marketplace yet: a demo site, a host worker with an isolated browser, and a
 * stand-in agent that encrypts tasks and decrypts the answers.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_ACCOUNT, startDemoSite } from "../apps/demo-site/src/server.ts";
import { HostWorker } from "../apps/worker/src/index.ts";
import { formatUsd, unitPrice } from "../packages/pricing/src/index.ts";
import { openResult, sealRequest } from "../packages/protocol/src/index.ts";

const site = await startDemoSite();
const dataDir = mkdtempSync(join(tmpdir(), "agentbnb-demo-"));
const worker = await HostWorker.start({ dataDir, siteOrigin: site.origin });

const heading = (text: string) => console.log(`\n── ${text} ${"─".repeat(Math.max(0, 66 - text.length))}`);

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
    result: output.wire,
    request: prepared.request,
    replyKeys: prepared.replyKeys,
    workerSigningKey: listing.signingKey,
  });
  console.log(`agent asks      ${capability} ${JSON.stringify(input)}`);
  console.log(`relay sees      ${prepared.request.ciphertext.slice(0, 44)}… (${prepared.request.ciphertext.length} chars of ciphertext)`);
  console.log(`worker decides  ${opened.status}${opened.reason ? ` (${opened.reason})` : ""}`);
  if (opened.body?.data) console.log(`agent receives  ${JSON.stringify(opened.body.data)}`);
  if (opened.body?.withheld.length) {
    console.log(`held back       ${opened.body.withheld.map((w) => `${w.field} [${w.reason}]`).join(", ")}`);
  }
  if (opened.body?.detectors.length) console.log(`checks fired    ${opened.body.detectors.join(", ")}`);
  console.log(`receipt         signed, request ${opened.receipt.requestHash.slice(0, 12)}…, result ${opened.receipt.resultHash?.slice(0, 12) ?? "none"}${opened.receipt.resultHash ? "…" : ""}`);
  return opened;
}

try {
  heading("Host sets up");
  console.log(`demo site       ${site.origin}`);
  console.log(`signed in       ${await worker.signIn(HOST_ACCOUNT.email, HOST_ACCOUNT.password)} (inside the isolated profile only)`);
  const offer = worker.listing().capabilities[0]!;
  const price = unitPrice(worker.listing().offers[0]!);
  console.log(`offering        ${offer.id} at ${formatUsd(price.amount)} per ${price.unit}`);
  console.log(`allowed fields  ${offer.fields.filter((f) => f.available).map((f) => f.name).join(", ")}`);
  console.log(`always blocked  ${offer.fields.filter((f) => f.alwaysBlocked).map((f) => f.name).join(", ")}`);

  heading("1. An allowed task");
  await rent("profile.read", { handle: "jordan-lee" });

  heading("2. The agent asks for private messages");
  await rent("messages.read", { thread: "latest" });

  heading("3. The agent tries to steer the browser to the inbox");
  await rent("profile.read", { handle: "jordan-lee", url: `${site.origin}/messages` });

  heading("4. A profile with contact details hidden in free text");
  await rent("profile.read", { handle: "sam-okafor" });

  heading("5. A profile written to hijack the agent");
  await rent("profile.read", { handle: "alex-rivera" });

  heading("6. The host allows email, then hits the kill switch");
  worker.setPolicy({ capabilities: { "profile.read": { enabled: true, allowFields: ["name", "email"] } }, maxTasksPerMinute: 30 });
  await rent("profile.read", { handle: "priya-nair" });
  worker.pause();
  console.log("");
  await rent("profile.read", { handle: "priya-nair" });

  heading("What the host can review afterwards");
  for (const entry of worker.auditEntries()) {
    console.log(
      `#${entry.seq}  ${entry.capability.padEnd(14)} ${entry.status.padEnd(9)} ${(entry.reason ?? "-").padEnd(20)} returned: ${entry.fieldsReturned.join(",") || "-"}`,
    );
  }
  const guard = worker.guardStats();
  console.log(`\naudit log intact: ${worker.auditIntact()}`);
  console.log(`requests the isolated browser refused: ${guard.blockedPath} to blocked pages (${[...new Set(guard.blockedPaths)].join(", ")}), ${guard.offOrigin} to other sites`);
  console.log(`inbox requests that reached the site: ${site.requests.filter((r) => r.includes("/messages")).length}`);
} finally {
  await worker.close();
  await site.close();
  rmSync(dataDir, { recursive: true, force: true });
}
