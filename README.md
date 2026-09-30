# x402 preflight

Catch a broken x402 paywall before an agent does. On every deploy this Action sends your paid endpoint one unpaid request and audits the 402 challenge it returns.

- **Free mode** (default, no wallet): reachability, HTTPS, HTTP 402, `PAYMENT-REQUIRED` header.
- **Paid mode** (`$0.01` USDC on Base per run): the full audit with a fix for every problem, covering:
  - CAIP-2 network and the canonical USDC asset (including testnet/mainnet mix-ups)
  - `payTo` EIP-55 checksum, price, and authorization window
  - EIP-712 domain, `resource.url` (https behind proxies)
  - Bazaar discovery metadata

## Quick start (free)

```yaml
# .github/workflows/x402-preflight.yml
name: x402 preflight
on: [deployment_status, workflow_dispatch]
jobs:
  preflight:
    runs-on: ubuntu-latest
    steps:
      - uses: aether/x402-preflight@v1
        with:
          url: https://api.example.com/v1/weather
```

If your endpoint validates the request before the paywall, pass what it needs:

```yaml
        with:
          url: https://api.example.com/v1/search
          body: '{"query":"example"}'
          headers: '{"idempotency-key":"ci-preflight-0001"}'
```

## Full audit (paid, $0.01)

1. Create a **new** wallet just for CI and send it a few cents of USDC on Base. It needs no ETH, because the facilitator pays gas.
2. Save its private key as a repository secret named `X402_CI_PAYER_KEY`.

```yaml
      - uses: aether/x402-preflight@v1
        with:
          url: https://api.example.com/v1/weather
          mode: paid
          payer-private-key: ${{ secrets.X402_CI_PAYER_KEY }}
          max-price: "0.02"   # hard cap; the action refuses to sign above it
          fail-on: warn       # fail | warn | never
```

The Action only signs for the default USDC asset on Base (`eip155:8453`), and never above `max-price` (default `0.05`).

## Inputs

| Input | Default | |
|---|---|---|
| `url` | (required) | Public https URL of the paid endpoint |
| `method` | POST if `body` is set, else GET | |
| `body` | | Example JSON body |
| `headers` | | JSON object of non-credential headers. `Authorization` and `Cookie` are refused. |
| `mode` | `free` | `free` or `paid` |
| `payer-private-key` | | Paid mode only. Always use a secret. |
| `max-price` | `0.05` | USDC cap per audit |
| `fail-on` | `fail` | `fail`, `warn` (also fails on inconclusive), or `never` |
| `gateway` | `https://aether-x402.vercel.app` | Audit service |

## Outputs

`verdict` (`pass`, `warn`, `fail` or `inconclusive`), `score` (0–100), `report-path` (JSON report), and `transaction` (Base settlement tx in paid mode). A table of every check is written to the job summary.

## CLI

```bash
npx x402-preflight --url https://api.example.com/v1/weather
X402_PAYER_PRIVATE_KEY=0x... npx x402-preflight --url https://api.example.com/v1/weather --mode paid
```

## Privacy

The audit sends one request to your endpoint with the body and headers you supply, and never sends a payment to it. Credential headers are rejected. Reports contain only what your public 402 challenge already exposes.
