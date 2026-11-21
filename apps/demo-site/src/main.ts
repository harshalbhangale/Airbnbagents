import { HOST_ACCOUNT, startDemoSite } from "./server.ts";

const site = await startDemoSite(Number(process.env.PORT ?? 4100));
console.log(`Meshwork demo site running at ${site.origin}`);
console.log(`Sign in with ${HOST_ACCOUNT.email} / ${HOST_ACCOUNT.password}`);
