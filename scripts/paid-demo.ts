/**
 * The full paid flow against the real x402 facilitator on Base Sepolia:
 * marketplace, host worker and an agent that pays in testnet USDC.
 *
 *   AGENT_PRIVATE_KEY     testnet-only key holding Base Sepolia USDC (required)
 *   HOST_PAYOUT_ADDRESS   where the host is paid (defaults to a burn address)
 *
 * The agent needs no ETH: the facilitator submits the transfer and pays gas.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { HOST_ACCOUNT, startDemoSite } from "../apps/demo-site/src/server.ts";
import { startMarketplace } from "../apps/server/src/index.ts";
import { HostWorker, connectToMarketplace } from "../apps/worker/src/index.ts";
import { formatUsd } from "../packages/pricing/src/index.ts";
import { AgentClient, PaymentRequiredError } from "../packages/sdk/src/index.ts";

const key = process.env.AGENT_PRIVATE_KEY;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error("Set AGENT_PRIVATE_KEY to a testnet-only private key that holds Base Sepolia USDC.");
  process.exit(1);
}
const wallet = privateKeyToAccount(key as `0x${string}`);
const payout = process.env.HOST_PAYOUT_ADDRESS ?? "0x000000000000000000000000000000000000dEaD";

const site = await startDemoSite();
const market = await startMarketplace({ facilitatorUrl: "https://x402.org/facilitator", network: "eip155:84532" });
const dataDir = mkdtempSync(join(tmpdir(), "agentbnb-paid-"));
const worker = await HostWorker.start({ dataDir, siteOrigin: site.origin });
const link = connectToMarketplace(worker, { url: market.hostUrl, payoutAddress: payout });

try {
  await worker.signIn(HOST_ACCOUNT.email, HOST_ACCOUNT.password);
  await link.ready;
  const agent = new AgentClient({ baseUrl: market.url, wallet });
  const listing = (await agent.listWorkers())[0]!;
  console.log(`agent wallet   ${wallet.address}`);
  console.log(`host payout    ${listing.payoutAddress}`);
  console.log(`network        Base Sepolia, via ${"https://x402.org/facilitator"}`);

  console.log("\n1. Paid task");
  try {
    const paid = await agent.runTask({ worker: listing, capability: "profile.read", input: { handle: "jordan-lee" } });
    console.log(`   result       ${paid.status} ${JSON.stringify(paid.data)}`);
    if (paid.payment) {
      console.log(`   paid         ${formatUsd(paid.payment.amount)} USDC to ${paid.payment.payTo}`);
      console.log(`   transaction  https://sepolia.basescan.org/tx/${paid.payment.transaction}`);
    }
  } catch (error) {
    if (!(error instanceof PaymentRequiredError)) throw error;
    console.log(`   not paid     ${error.message}`);
    console.log(`   Fund ${wallet.address} with Base Sepolia USDC and run this again.`);
  }

  console.log("\n2. Request for private messages");
  const denied = await agent.runTask({ worker: listing, capability: "messages.read", input: { thread: "latest" } });
  console.log(`   result       ${denied.status} (${denied.reason}), charged: ${denied.payment ? "yes" : "no"}`);

  console.log(`\nhost earnings  ${formatUsd(worker.earnings().host)} from ${worker.earnings().payments} payment(s)`);
} finally {
  link.close();
  await worker.close();
  await market.close();
  await site.close();
  rmSync(dataDir, { recursive: true, force: true });
}
