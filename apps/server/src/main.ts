import { startMarketplace } from "./server.ts";

const marketplace = await startMarketplace({
  port: Number(process.env.PORT ?? 4200),
  publicUrl: process.env.PUBLIC_URL,
  facilitatorUrl: process.env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator",
  network: process.env.X402_NETWORK ?? "eip155:84532",
});
console.log(`agentbnb marketplace listening at ${marketplace.url}`);
console.log(`host workers connect to ${marketplace.hostUrl}`);
