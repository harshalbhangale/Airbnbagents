import { privateKeyToAccount } from "viem/accounts";
import { StripeProcessor } from "./cards.ts";
import { startMarketplace } from "./server.ts";
import { Treasury } from "./treasury.ts";

/**
 * The marketplace: `pnpm marketplace`.
 *
 *   PORT, PUBLIC_URL        where it listens and how the outside world reaches it
 *   X402_FACILITATOR_URL    x402 facilitator (default the public one)
 *   X402_NETWORK            CAIP-2 network (default Base Sepolia)
 *   ACCOUNTS_FILE           where renter accounts and credit are kept
 *
 * Card payments switch on when both of these are set:
 *   STRIPE_SECRET_KEY       Stripe secret key (use a test-mode key off mainnet)
 *   TREASURY_PRIVATE_KEY    the marketplace wallet that pays hosts for card renters; it needs USDC on the network
 */
const stripeKey = process.env.STRIPE_SECRET_KEY;
const treasuryKey = process.env.TREASURY_PRIVATE_KEY;
const card =
  stripeKey && treasuryKey && /^0x[0-9a-fA-F]{64}$/.test(treasuryKey)
    ? { processor: new StripeProcessor({ secretKey: stripeKey }), treasury: new Treasury(privateKeyToAccount(treasuryKey as `0x${string}`)) }
    : undefined;

const marketplace = await startMarketplace({
  port: Number(process.env.PORT ?? 4200),
  publicUrl: process.env.PUBLIC_URL,
  facilitatorUrl: process.env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator",
  network: process.env.X402_NETWORK ?? "eip155:84532",
  accountsFile: process.env.ACCOUNTS_FILE ?? ".agentbnb/accounts.jsonl",
  card,
});
console.log(`agentbnb marketplace listening at ${marketplace.url}`);
console.log(`host workers connect to ${marketplace.hostUrl}`);
console.log(`renter console at ${marketplace.url}/console`);
console.log(card ? `card payments on, treasury ${card.treasury.address}` : "card payments off (set STRIPE_SECRET_KEY and TREASURY_PRIVATE_KEY to turn them on)");
