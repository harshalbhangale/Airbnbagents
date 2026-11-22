# Hosted demo on AWS

`template.yaml` creates one small server that runs the marketplace and the
demo site behind HTTPS. It is everything in one CloudFormation stack: deleting
the stack removes all of it.

## What it creates

| Resource | Why |
|---|---|
| One EC2 instance (`t4g.small`, Amazon Linux 2023, 16 GB disk) | Runs the marketplace, the demo site and Caddy |
| One Elastic IP | A stable address, so the web addresses do not change on restart |
| One security group | Opens ports 80 and 443 only. There is no SSH |
| One IAM role | Lets the server be managed through Systems Manager and read its own payment keys |

Expect roughly $17 a month while it runs: about $12 for the instance, $4 for
the public address and $1 for the disk.

## Addresses

The addresses use `sslip.io`, a public service that maps a name containing an
IP address to that address, so no domain is needed and Caddy can obtain real
certificates. The stack's outputs list them:

- `MarketplaceUrl`, and the renter console at `/console`
- `HostEndpoint`, which the desktop app connects to
- `DemoSiteUrl`

For anything beyond a demo, put your own domain in front instead.

## Payment keys

The server reads payment settings at start-up from Parameter Store, under the
path in the `SecretsPath` output. Store each as a `SecureString` named after
the setting, for example `/agentbnb/<stack>/DODO_PAYMENTS_API_KEY`, then
restart the service (`systemctl restart agentbnb-marketplace`).

Card payments need `TREASURY_PRIVATE_KEY` plus either `DODO_PAYMENTS_API_KEY`
and `DODO_PRODUCT_ID`, or `STRIPE_SECRET_KEY`. Without them the marketplace
runs with crypto payments only.

**Think before pairing a live card key with the testnet.** On the default
network, hosts are paid in testnet USDC, which is worth nothing, so a live
card key means real money is taken for a demo. A test-mode card key is the
safer choice there. If a live key is used on the testnet anyway, keep
`TOP_UP_MAX_USD` low (it can be stored alongside the keys); the renter console
shows a notice next to the pay buttons whenever the marketplace is on a test
network.

## Looking after it

There is no SSH. Use Systems Manager Session Manager to get a shell, or Run
Command to run one. Useful places on the server:

- `/var/log/agentbnb-bootstrap.log` for the first-boot set-up
- `journalctl -u agentbnb-marketplace`, `-u agentbnb-demo-site`, `-u caddy`
- `/var/lib/agentbnb/accounts.jsonl` for renter accounts and credit

**Running a newer commit.** The set-up script runs only when the server is
first created, so changing the stack's `Commit` afterwards restarts the server
without redeploying anything. Instead, run this on the server through Systems
Manager Run Command:

```sh
agentbnb-deploy <full 40-character commit>
```

It fetches that commit, installs and restarts the services. Renter accounts
are kept. Anything that changes the server itself (the set-up script, instance
size) needs the server replaced, which clears renter accounts: copy
`accounts.jsonl` off first if it matters.

## Limits

- One server, no backups, accounts on its local disk.
- The marketplace has only light protection against abuse (a cap on new
  accounts per minute).
- The demo site's sign-in details are public by design; it holds only made-up
  data.
