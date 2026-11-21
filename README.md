# agentbnb

A marketplace where people rent narrow, permission-controlled capabilities of
their own signed-in browser sessions to AI agents, and get paid per task.

This repository currently holds the host side: the program a host runs on their
own machine, and the privacy layer every task passes through. Payment, the
marketplace server, the agent SDK and the dashboard are not built yet.

## Run it

Requires Node 22+ and pnpm.

```sh
pnpm install
npx playwright install chromium   # skip if Chromium for Playwright is already installed
pnpm test                         # unit tests plus an end-to-end run in a real browser
pnpm demo                         # the whole host-side flow, narrated in the terminal
pnpm demo-site                    # just the demo site, on http://127.0.0.1:4100
```

## What is here

| Path | What it is |
|---|---|
| `packages/protocol` | Shared by agents and workers: encryption, message envelopes, capability definitions, receipt checking |
| `packages/privacy` | The privacy layer: host rules, allowlist redaction, outbound scan, signed receipts, audit log |
| `apps/worker` | The host worker: an isolated browser profile with a network guard, plus the fixed task code |
| `apps/demo-site` | Meshwork, a made-up professional network with profiles and a private inbox |
| `scripts/demo.ts` | A stand-in agent driving the worker through allowed, denied and hostile requests |

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
  see only the capability name, sizes and timing.
- **Not the task from the host.** The host's machine decrypts and runs the
  task, so the host can see what was asked and what was returned.
- **The outbound scan is a backstop, not a guarantee.** It is pattern-based.
  The allowlist and the fixed task code are what actually keep private data in.
- The isolated profile protects the host's other accounts only if the host
  signs in to nothing else inside it.

The demo runs against a synthetic site on purpose. Automating a real site
through someone's account is subject to that site's terms.
