// Bundles the desktop app's main process into one file and copies the dashboard page next to it.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(here, "src/main.ts")],
  outfile: join(dist, "main.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["electron"],
  // The desktop app drives its own built-in browser, so the Playwright driver is left out of the bundle.
  alias: { playwright: join(here, "src/no-playwright.ts") },
  logLevel: "warning",
});

cpSync(join(here, "../worker/src/dashboard/public"), join(dist, "public"), { recursive: true });

/** A small tray icon, drawn here so the repository carries no binary assets: a ring with a centre dot. */
function trayIcon(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const mid = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - mid, y - mid) / mid;
      const on = (d <= 1 && d >= 0.72) || d <= 0.34;
      const edge = Math.max(0, Math.min(1, (1 - d) * mid));
      const at = y * (size * 4 + 1) + 1 + x * 4;
      raw.set([11, 107, 82, on ? Math.round(255 * (d > 0.9 ? edge : 1)) : 0], at);
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
writeFileSync(join(dist, "tray.png"), trayIcon(32));
