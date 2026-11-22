import { privateKeyToAccount } from "viem/accounts";
import { DodoProcessor, StripeProcessor } from "./cards.ts";
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
 * Card payments switch on when a card processor and a treasury wallet are both set:
 *   TREASURY_PRIVATE_KEY    the marketplace wallet that pays hosts for card renters; it needs USDC on the network
 * and one of
 *   DODO_PAYMENTS_API_KEY + DODO_PRODUCT_ID   Dodo Payments; the product is a one-time "Pay What You Want" product in USD
 *   STRIPE_SECRET_KEY                         Stripe
 * Use test-mode keys anywhere but production.
 */
const treasuryKey = process.env.TREASURY_PRIVATE_KEY;
const processor =
  process.env.DODO_PAYMENTS_API_KEY && process.env.DODO_PRODUCT_ID
    ? new DodoProcessor({ apiKey: process.env.DODO_PAYMENTS_API_KEY, productId: process.env.DODO_PRODUCT_ID })
    : process.env.STRIPE_SECRET_KEY
      ? new StripeProcessor({ secretKey: process.env.STRIPE_SECRET_KEY })
      : undefined;
const card =
  processor && treasuryKey && /^0x[0-9a-fA-F]{64}$/.test(treasuryKey)
    ? { processor, treasury: new Treasury(privateKeyToAccount(treasuryKey as `0x${string}`)) }
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
console.log(
  card
    ? `card payments on through ${processor instanceof DodoProcessor ? "Dodo Payments" : "Stripe"}, treasury ${card.treasury.address}`
    : "card payments off (set a card processor's keys and TREASURY_PRIVATE_KEY to turn them on)",
);
