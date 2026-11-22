import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EarningsLedger,
  OfferError,
  PRODUCTS,
  PRODUCT_KINDS,
  SessionMeter,
  billableMinutes,
  formatUsd,
  minutesCovered,
  parseOffers,
  priceOfMinutes,
  quote,
  split,
  unitPrice,
  usd,
  type HourlyOffer,
  type Offer,
} from "../src/index.ts";

const [browser, regional, session, api, dedicated] = parseOffers([
  { kind: "browser_node", pricePerHour: usd(2.4) },
  { kind: "regional_browser", region: "DE", pricePerHour: usd(3.6), minimumMinutes: 5 },
  { kind: "automation_session", capability: "profile.read", pricePerSession: usd(0.02) },
  { kind: "agent_api", pricePerCall: usd(0.001) },
  { kind: "dedicated_node", pricePerMonth: usd(120) },
]) as [HourlyOffer, HourlyOffer, Offer, Offer, Offer];

describe("plans", () => {
  it("covers the five products, each with its own unit", () => {
    expect(PRODUCT_KINDS.map((kind) => PRODUCTS[kind].unit)).toEqual(["hour", "hour", "session", "call", "month"]);
    expect([browser, regional, session, api, dedicated].map((o) => unitPrice(o))).toEqual([
      { amount: 2_400_000, unit: "hour" },
      { amount: 3_600_000, unit: "hour" },
      { amount: 20_000, unit: "session" },
      { amount: 1_000, unit: "call" },
      { amount: 120_000_000, unit: "month" },
    ]);
  });

  it("fills in sensible defaults", () => {
    expect(browser).toMatchObject({ minimumMinutes: 1, maxSessionMinutes: 240 });
    expect(dedicated).toMatchObject({ termDays: 30 });
  });

  it.each([
    ["a zero price", [{ kind: "browser_node", pricePerHour: 0 }]],
    ["a negative price", [{ kind: "agent_api", pricePerCall: -5 }]],
    ["a fractional micro-dollar", [{ kind: "agent_api", pricePerCall: 0.5 }]],
    ["a regional browser with no region", [{ kind: "regional_browser", pricePerHour: 1000 }]],
    ["a lower-case region", [{ kind: "regional_browser", region: "de", pricePerHour: 1000 }]],
    ["an unknown product", [{ kind: "claude_plan", pricePerHour: 1000 }]],
    ["an unexpected extra setting", [{ kind: "agent_api", pricePerCall: 1000, freeCalls: 10 }]],
    ["an automation session with no capability", [{ kind: "automation_session", pricePerSession: 1000 }]],
    ["the same product listed twice", [{ kind: "agent_api", pricePerCall: 1000 }, { kind: "agent_api", pricePerCall: 2000 }]],
    ["the same region listed twice", [
      { kind: "regional_browser", region: "DE", pricePerHour: 1000 },
      { kind: "regional_browser", region: "DE", pricePerHour: 2000 },
    ]],
  ])("refuses %s", (_label, raw) => {
    expect(() => parseOffers(raw)).toThrow(OfferError);
  });

  it("allows one regional browser per region and one automation offer per capability", () => {
    expect(
      parseOffers([
        { kind: "regional_browser", region: "DE", pricePerHour: 1000 },
        { kind: "regional_browser", region: "JP", pricePerHour: 2000 },
        { kind: "automation_session", capability: "profile.read", pricePerSession: 1 },
        { kind: "automation_session", capability: "company.read", pricePerSession: 1 },
      ]),
    ).toHaveLength(4);
  });
});

describe("quotes", () => {
  it("bills hourly products by the started minute", () => {
    expect(quote(browser, { seconds: 600 })).toEqual({ gross: 400_000, fee: 40_000, host: 360_000, quantity: 10, unit: "minute" });
    expect(quote(browser, { seconds: 61 }).quantity).toBe(2);
    expect(quote(browser, { seconds: 1 }).gross).toBe(40_000);
    expect(quote(browser, { seconds: 0 }).gross).toBe(0);
  });

  it("applies the host's minimum and maximum session length", () => {
    expect(billableMinutes(regional, 30)).toBe(5);
    expect(quote(regional, { seconds: 30 }).gross).toBe(300_000);
    expect(billableMinutes(browser, 10 * 3600)).toBe(240);
  });

  it("bills sessions, calls and terms per unit", () => {
    expect(quote(session, { sessions: 3 })).toMatchObject({ gross: 60_000, fee: 6_000, host: 54_000, unit: "session" });
    expect(quote(api, { calls: 2_500 })).toMatchObject({ gross: 2_500_000, fee: 250_000, host: 2_250_000, unit: "call" });
    expect(quote(dedicated, { terms: 1 })).toMatchObject({ gross: 120_000_000, fee: 12_000_000, host: 108_000_000, unit: "term" });
  });

  it("refuses the wrong kind of usage for a product", () => {
    expect(() => quote(browser, { calls: 1 })).toThrow(TypeError);
    expect(() => quote(session, { seconds: 60 })).toThrow(TypeError);
    expect(() => quote(api, { calls: 1.5 })).toThrow(RangeError);
    expect(() => quote(api, { calls: -1 })).toThrow(RangeError);
  });

  it("always splits an amount exactly, with the odd unit going to the host", () => {
    for (const gross of [0, 1, 9, 10, 11, 99, 12_345, 1_000_001, 987_654_321]) {
      for (const bps of [0, 1, 250, 1000, 3333, 5000]) {
        const s = split(gross, bps);
        expect(s.fee + s.host).toBe(gross);
        expect(s.fee).toBeLessThanOrEqual((gross * bps) / 10_000);
        expect(Number.isInteger(s.fee) && Number.isInteger(s.host)).toBe(true);
      }
    }
    expect(split(9, 1000)).toEqual({ gross: 9, fee: 0, host: 9 });
    expect(() => split(100, 6000)).toThrow(RangeError);
  });

  it("never gives the renter more minutes than they paid for", () => {
    const awkward: HourlyOffer = { kind: "browser_node", pricePerHour: 1_000_001, minimumMinutes: 1, maxSessionMinutes: 240 };
    for (const offer of [browser, regional, awkward]) {
      for (let minutes = 1; minutes <= 120; minutes++) {
        const price = priceOfMinutes(offer, minutes);
        expect(minutesCovered(offer, price)).toBe(minutes);
        expect(minutesCovered(offer, price - 1)).toBe(minutes - 1);
      }
    }
  });

  it("formats amounts for display", () => {
    expect([usd(0.02), usd(2.4), usd(1234.5), 1, usd(0)].map(formatUsd)).toEqual(["$0.02", "$2.40", "$1,234.50", "$0.000001", "$0.00"]);
  });
});

describe("prepaid session meter", () => {
  const t0 = 1_800_000_000_000;

  it("runs for exactly the time that was paid, block by block", () => {
    const meter = new SessionMeter(browser, t0);
    expect(meter.isActive(t0)).toBe(false);

    expect(meter.addPayment(meter.blockPrice(5), t0)).toBe(5);
    expect(meter.isActive(t0 + 4 * 60_000)).toBe(true);
    expect(meter.secondsRemaining(t0 + 4 * 60_000)).toBe(60);

    expect(meter.addPayment(meter.blockPrice(5), t0 + 4 * 60_000)).toBe(5);
    expect(meter.isActive(t0 + 9 * 60_000 + 59_000)).toBe(true);
    expect(meter.isActive(t0 + 10 * 60_000)).toBe(false);

    expect(meter.close(t0 + 10 * 60_000)).toEqual({ gross: 400_000, fee: 40_000, host: 360_000, quantity: 10, unit: "minute" });
  });

  it("stops when the paid time runs out and cannot be revived afterwards", () => {
    const meter = new SessionMeter(browser, t0);
    meter.addPayment(meter.blockPrice(1), t0);
    expect(meter.isActive(t0 + 60_000)).toBe(false);
    expect(() => meter.addPayment(40_000, t0 + 61_000)).toThrow(/ran out/);
  });

  it("enforces the host's minimum first block and maximum session length", () => {
    const meter = new SessionMeter(regional, t0);
    expect(() => meter.blockPrice(2)).toThrow(/at least 5 minutes/);
    expect(() => meter.addPayment(priceOfMinutes(regional, 2), t0)).toThrow(RangeError);
    meter.addPayment(meter.blockPrice(5), t0);
    expect(meter.blockPrice(1)).toBe(60_000);

    const capped = new SessionMeter({ ...browser, maxSessionMinutes: 10 }, t0);
    capped.addPayment(capped.blockPrice(10), t0);
    expect(() => capped.blockPrice(1)).toThrow(/limits a session/);
  });

  it("refuses a payment too small to buy a minute, and any payment after closing", () => {
    const meter = new SessionMeter(browser, t0);
    expect(() => meter.addPayment(39_999, t0)).toThrow(RangeError);
    meter.addPayment(40_000, t0);
    meter.close(t0 + 30_000);
    expect(meter.isActive(t0 + 31_000)).toBe(false);
    expect(() => meter.addPayment(40_000, t0 + 31_000)).toThrow(/closed/);
  });
});

describe("earnings ledger", () => {
  it("counts each settled payment once and totals by product", () => {
    const ledger = new EarningsLedger();
    expect(ledger.record("base-sepolia:0xaaa1", "automation_session", quote(session, { sessions: 1 }), 1000)).toBe(true);
    expect(ledger.record("base-sepolia:0xaaa1", "automation_session", quote(session, { sessions: 1 }), 2000)).toBe(false);
    expect(ledger.record("base-sepolia:0xbbb2", "browser_node", quote(browser, { seconds: 600 }), 3000)).toBe(true);

    const summary = ledger.summary();
    expect(summary).toMatchObject({ payments: 2, gross: 420_000, fee: 42_000, host: 378_000 });
    expect(summary.byKind.automation_session).toEqual({ payments: 1, host: 18_000 });
    expect(summary.byKind.browser_node).toEqual({ payments: 1, host: 360_000 });
    expect(ledger.summary(2500).payments).toBe(1);
  });

  it("refuses an entry that does not add up or has no real payment reference", () => {
    const ledger = new EarningsLedger();
    expect(() => ledger.record("base-sepolia:0xccc3", "agent_api", { gross: 100, fee: 10, host: 95, quantity: 1, unit: "call" }, 1)).toThrow(RangeError);
    expect(() => ledger.record("base-sepolia:0xccc3", "agent_api", quote(api, { calls: 0 }), 1)).toThrow(RangeError);
    expect(() => ledger.record("x", "agent_api", quote(api, { calls: 1 }), 1)).toThrow(RangeError);
    expect(ledger.entries()).toEqual([]);
  });

  it("separates payments confirmed onchain from those still awaiting a check", () => {
    const ledger = new EarningsLedger();
    ledger.record("base-sepolia:0xaaa1", "automation_session", quote(session, { sessions: 1 }), 1000);
    ledger.record("base-sepolia:0xbbb2", "automation_session", quote(session, { sessions: 1 }), 2000);
    ledger.record("base-sepolia:0xccc3", "automation_session", quote(session, { sessions: 1 }), 3000);
    expect(ledger.summary()).toMatchObject({ payments: 3, host: 54_000, confirmed: { payments: 0, host: 0 }, awaiting: { payments: 3, host: 54_000 } });

    expect(ledger.resolve("base-sepolia:0xaaa1", "confirmed")).toBe(true);
    expect(ledger.resolve("base-sepolia:0xbbb2", "failed")).toBe(true);
    // A payment that failed its check counts for nothing.
    expect(ledger.summary()).toMatchObject({ payments: 2, host: 36_000, confirmed: { payments: 1, host: 18_000 }, awaiting: { payments: 1, host: 18_000 } });
    expect(ledger.summary().byKind.automation_session).toEqual({ payments: 2, host: 36_000 });

    // A confirmed payment cannot be un-confirmed, and an unknown one cannot be resolved.
    expect(ledger.resolve("base-sepolia:0xaaa1", "failed")).toBe(false);
    expect(ledger.resolve("base-sepolia:0xzzz9", "confirmed")).toBe(false);
    expect(ledger.get("base-sepolia:0xaaa1")?.state).toBe("confirmed");
    expect(ledger.entries().map((e) => e.at)).toEqual([3000, 2000, 1000]);
  });

  it("survives a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentbnb-ledger-"));
    try {
      const file = join(dir, "earnings.jsonl");
      const first = new EarningsLedger(file);
      first.record("base-sepolia:0xddd4", "dedicated_node", quote(dedicated, { terms: 1 }), 5);
      first.resolve("base-sepolia:0xddd4", "confirmed");
      const reopened = new EarningsLedger(file);
      expect(reopened.summary().host).toBe(108_000_000);
      expect(reopened.summary().confirmed.host).toBe(108_000_000);
      expect(reopened.record("base-sepolia:0xddd4", "dedicated_node", quote(dedicated, { terms: 1 }), 6)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
