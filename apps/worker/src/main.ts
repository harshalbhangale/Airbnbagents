import { homedir } from "node:os";
import { join } from "node:path";
import { HostApp } from "./app.ts";
import { startDashboard } from "./dashboard/server.ts";

/**
 * The host app: `pnpm host`.
 *
 *   AGENTBNB_HOME     where keys, rules and the browser profile live (default ~/.agentbnb)
 *   SITE_ORIGIN       the site the rented account is on (default the local demo site)
 *   MARKETPLACE_URL   the marketplace's host endpoint (default a local marketplace)
 *   DASHBOARD_PORT    port for the dashboard (default 4300)
 */
const app = await HostApp.start({
  dataDir: process.env.AGENTBNB_HOME ?? join(homedir(), ".agentbnb"),
  siteOrigin: process.env.SITE_ORIGIN ?? "http://127.0.0.1:4100",
  marketplaceUrl: process.env.MARKETPLACE_URL ?? "ws://127.0.0.1:4200/hosts/connect",
});
const dashboard = await startDashboard(app, { port: Number(process.env.DASHBOARD_PORT ?? 4300) });
console.log("agentbnb host is running.");
console.log(`Open your dashboard: ${dashboard.url}`);

const stop = async () => {
  await dashboard.close();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
