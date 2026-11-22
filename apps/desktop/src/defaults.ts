/**
 * Where the desktop app connects when nothing else is configured. These point
 * at the local demo. Once a hosted marketplace exists (see deploy/aws), put
 * its `HostEndpoint` and `DemoSiteUrl` here so the installers work out of the
 * box.
 */
export const DEFAULT_MARKETPLACE_URL = "ws://127.0.0.1:4200/hosts/connect";
export const DEFAULT_SITE_ORIGIN = "http://127.0.0.1:4100";
