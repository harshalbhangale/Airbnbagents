# agentbnb

A marketplace where people rent narrow, permission-controlled capabilities of
their own signed-in browser sessions to AI agents, and get paid per task.

What is built: the desktop app for hosts, the host worker and its privacy
layer, the host dashboard with revenue, the marketplace server, payment by
crypto or by card, the renter console, the agent SDK, and pricing. Not built
yet: the MCP server, the onchain commitment contract, hourly browser sessions,
open-model inference and the platform fee split.

## Run it

Requires Node 22+ and pnpm.

```sh
pnpm install
npx playwright install chromium   # skip if Chromium for Playwright is already installed
pnpm test                         # unit tests plus an end-to-end run in a real browser
pnpm demo                         # the host-side flow, no payment, narrated in the terminal
pnpm demo:paid                    # the full paid flow on Base Sepolia (see below)
pnpm marketplace                  # just the marketplace server, on http://127.0.0.1:4200
pnpm host                         # the host app in a terminal: worker plus dashboard
pnpm desktop                      # the host app as a desktop app (see below)
pnpm demo-site                    # just the demo site, on http://127.0.0.1:4100
```

## What is here

| Path | What it is |
|---|---|
| `packages/protocol` | Shared by agents and workers: encryption, message envelopes, capability definitions, receipt checking |
| `packages/privacy` | The privacy layer: host rules, allowlist redaction, outbound scan, signed receipts, audit log |
| `packages/pricing` | The five plans, quotes in USDC units, the prepaid session meter and the host earnings ledger |
| `apps/server` | The marketplace: worker registry, x402 paywall, encrypted task relay |
| `packages/sdk` | What an agent uses: discover, encrypt, pay, verify, decrypt |
| `apps/desktop` | The desktop app: the worker and dashboard in a window, with a built-in browser for the rented account |
| `apps/worker` | The host worker: an isolated browser profile with a network guard, plus the fixed task code |
| `apps/demo-site` | Meshwork, a made-up professional network with profiles and a private inbox |
| `scripts/demo.ts` | A stand-in agent driving the worker through allowed, denied and hostile requests |

## The desktop app

`pnpm desktop` opens the host app in its own window. It is the same worker and
dashboard, with two differences:

- **A built-in browser for the rented account.** The app keeps a separate
  browser session inside itself, with its own cookies, so nothing else needs
  installing and the host's everyday browser is never involved.
- **A real sign-in window.** The host signs in on the site's own page in a
  window of that separate session. Their details are never typed into
  agentbnb.

Closing the window leaves the host online in the tray; quit from the tray
menu. By default the app connects to the local demo site and a local
marketplace. To point it elsewhere, set `AGENTBNB_MARKETPLACE_URL` and
`AGENTBNB_SITE_ORIGIN`, or put `marketplaceUrl` and `siteOrigin` in
`config.json` in the app's data folder.

**Installers.** `pnpm desktop:dist` builds an installer for the machine it runs
on. The "Desktop app" workflow on GitHub builds all three (a `.dmg` for macOS
on Apple and Intel chips, an `.exe` for Windows, an AppImage for Linux) and
attaches them to the workflow run as artifacts. They are unsigned, so macOS
and Windows warn before opening them; signing needs an Apple Developer account
and a Windows certificate.

The desktop app has its own end-to-end test, which drives the real app:
`xvfb-run -a pnpm test` on Linux, plain `pnpm test` on macOS or Windows.

## Running as a host

Start the demo site and a marketplace in two terminals (`pnpm demo-site`,
`pnpm marketplace`), then `pnpm host`. It prints a one-time link to the
dashboard, where the host signs the rented account in, enters a payout
address, chooses which fields agents may receive, sets a price, watches
activity and earnings, and can pause everything with one button. The worker is
listed on the marketplace once it has a payout address.

The dashboard can change privacy rules, so it only listens on the local
machine, needs the one-time link, answers only to its own address (which
defeats DNS rebinding) and checks the origin of every change (which defeats
requests forged by other pages in the same browser). Signing in currently
means typing the account's details into the dashboard, which passes them to
the site's own sign-in page inside the separate browser profile and does not
keep them. A window the host signs in to directly will replace that with the
desktop app.

## Plans

| Product | Unit | Status |
|---|---|---|
| Automation session | per session | Deliverable now |
| Agent API | per call | Priced; needs the marketplace server |
| Browser node | per hour, billed by the minute | Priced; not deliverable yet |
| Regional browser | per hour, in a named country | Priced; not deliverable yet |
| Dedicated node | per month | Priced; not deliverable yet |

Amounts are whole micro-dollars, which is USDC's smallest unit. The platform
fee is 10% by default and rounds down, so a split always adds up exactly.
Hourly sessions are prepaid one block of minutes at a time and stop when the
paid time runs out, so neither side can lose more than one block. A worker
refuses to list a product it cannot deliver, and its earnings ledger records
settled payments only.

## Payment

Hosts are always paid in USDC, straight to their own address, when a task
completes. Renters can pay in either of two ways.

### Paying with crypto

Tasks are paid with x402 "exact" payments in USDC on Base Sepolia.

1. The agent posts an encrypted task. If the host has set a price for that
   capability, the marketplace answers `402` with the price and the host's
   payout address.
2. The agent signs an authorization for exactly that amount and posts again.
   The marketplace verifies it through the facilitator. Nothing has moved yet.
3. The worker runs the task. The marketplace checks the worker's signed
   receipt against the request before going further.
4. Only if the task completed is the payment submitted onchain, and only once
   it settles is the result released. A denied, rejected, withheld or failed
   task costs the agent nothing.

The payment goes straight from the agent to the host's address; the
marketplace never holds funds. The 10% platform fee is not collected yet: it
needs a splitter contract, which comes with the contract work. The agent needs
no ETH, because the facilitator submits the transfer.

### Paying by card

A renter opens an account in the renter console (`/console` on the
marketplace), buys credit by card, and gives their agent the account's API key
(`new AgentClient({ baseUrl, apiKey })`).

1. Buying credit sends the renter to Stripe's own checkout page. Card details
   never reach agentbnb. When they return, the marketplace asks Stripe whether
   the payment went through and adds the credit. A payment can credit only the
   account it was opened for, and only once.
2. When the agent runs a task, the marketplace holds the price from the
   renter's credit and has its own wallet (the treasury) pay the host through
   the same x402 payment as above.
3. If the task completes and the payment settles, the hold becomes a charge.
   If the task is denied, rejected, withheld or fails, or settlement fails,
   the credit is released.

Card payments are on when the marketplace is started with `STRIPE_SECRET_KEY`
and `TREASURY_PRIVATE_KEY`, and the treasury wallet holds USDC on the network.

Things to know before taking real card payments:

- **The marketplace holds renters' prepaid credit.** That is different from
  the crypto path, where it never holds funds, and it carries obligations
  (refunds, chargebacks, and in many places money-services rules) that need
  proper advice.
- **Stripe's fee comes out of each top-up**, which is why the minimum is $5.
- **The treasury must be kept funded.** If it runs dry, card-paid tasks are
  refused and the renter's credit is untouched.
- The automated tests run the real Stripe client code against a local
  stand-in for Stripe. The flow has not yet been run against Stripe itself.
- Anyone can open an account, and the console keeps the API key in the
  browser's local storage. Both want tightening before a public launch.

### Running the paid flow yourself

To run the crypto flow for real, fund a testnet-only wallet with Base Sepolia
USDC (for example from Circle's faucet) and run:

```sh
AGENT_PRIVATE_KEY=0x... HOST_PAYOUT_ADDRESS=0x... pnpm demo:paid
```

The automated tests exercise the real x402 client and server code against a
local stand-in for the facilitator and chain. The paid flow has also been run
once on Base Sepolia through the public facilitator: a $0.02 task settled in
transaction
[`0xcaae353d…c18d94`](https://sepolia.basescan.org/tx/0xcaae353d5f53b277e86323d9bbd3d396db1bd89f7f6e50b9877abcc5bdc18d94),
moving USDC straight from the agent's wallet to the host's.

## How a task flows

1. The agent encrypts the task to the worker's public key. The capability name
   and task id are bound into the ciphertext, so a relay cannot re-label it.
2. The worker's privacy layer refuses blocked categories (messages, cookies,
   credentials and so on) before decrypting anything.
3. It decrypts, then validates the input against a strict schema. There is no
   field for a URL, selector or script.
4. It works out which fields the host allows and tells the task code to read
   only those. The task code opens one fixed URL in an isolated browser profile
   whose network guard refuses other sites, the inbox and anything but GET.
5. The result is rebuilt from the allowlist, each value is checked against its
   schema, and the remainder is scanned for contact details, secrets, markup,
   hidden characters and text aimed at hijacking the agent. One hit discards
   the whole result.
6. The answer is encrypted to the agent's one-time key. The worker signs a
   receipt over the hashes of both ciphertexts and appends a line to a
   hash-chained audit log that records decisions, never content.

The worker's network code can only send a `SealedOutput`, and only the privacy
layer can create one.

## What this protects, and what it does not

- **The host's account from the agent.** The agent gets approved fields as JSON
  and nothing else: no page, no screenshot, no cookies, no free navigation.
- **The task from the marketplace and the network.** They relay ciphertext and
  see only the capability name, sizes, timing and payment.
- **Not the agent from a marketplace that lies about keys.** An agent encrypts
  to the key in the listing the marketplace serves. Until worker keys are
  anchored onchain, an agent that cares should pin a worker's keys after first
  use.
- **A host's earnings are checked against the chain.** A payment the
  marketplace reports is looked up onchain: it counts as confirmed only when
  the transaction really moved that amount of USDC to the host's address, and
  is dropped if it did not.
- **The browser guard is built to fail closed.** Blocked pages are blocked
  inside the browser, not by this program answering in time, because a request
  held for a decision when its tab closes would otherwise be let through. On
  the command-line worker, refusing non-GET requests and other sites addressed
  by raw IP still relies on interception, with tabs drained before they close;
  the desktop app judges every request before it is sent.
- **Not the task from the host.** The host's machine decrypts and runs the
  task, so the host can see what was asked and what was returned.
- **The outbound scan is a backstop, not a guarantee.** It is pattern-based.
  The allowlist and the fixed task code are what actually keep private data in.
- The isolated profile protects the host's other accounts only if the host
  signs in to nothing else inside it.

The demo runs against a synthetic site on purpose. Automating a real site
through someone's account is subject to that site's terms.
