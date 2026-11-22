/**
 * Where the desktop app connects when nothing else is configured: the hosted
 * demo marketplace and demo site created by deploy/aws. If that stack is
 * rebuilt with a different address, or replaced by a real domain, update
 * these with its `HostEndpoint` and `DemoSiteUrl` outputs.
 */
export const DEFAULT_MARKETPLACE_URL = "wss://market.35-154-72-7.sslip.io/hosts/connect";
export const DEFAULT_SITE_ORIGIN = "https://meshwork.35-154-72-7.sslip.io";
