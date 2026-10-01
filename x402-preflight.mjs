#!/usr/bin/env node
// x402-preflight: audit an x402 endpoint before agents try to pay it.
//
//   GitHub Action: inputs arrive as INPUT_* env vars (see action.yml).
//   CLI:           node x402-preflight.mjs --url https://api.example.com/paid [--method POST] [--body '{"q":1}']
//                  [--headers '{"idempotency-key":"ci-1"}'] [--mode free|paid] [--fail-on fail|warn|never]
//                  [--max-price 0.05] [--gateway https://aether-x402.vercel.app]
//                  [--expect '{"network":"eip155:8453","asset":"0x8335...","maxPriceUsd":0.05}']  (checked in paid mode)
//                  paid mode reads the payer key from X402_PAYER_PRIVATE_KEY (or INPUT_PAYER-PRIVATE-KEY).
//
// Free mode runs the shallow audit (reachability, HTTP 402, challenge header). Paid mode buys the
// full audit ($0.01 USDC on Base) with per-check fixes; a hard spend cap guards the payer wallet.
import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_GATEWAY = "https://aether-x402.vercel.app";
const PAID_NETWORK = "eip155:8453";

function readOptions(argv = process.argv.slice(2), env = process.env) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? "true" : argv[++i];
  const input = name => flags[name] ?? env[`INPUT_${name.toUpperCase()}`] ?? env[`INPUT_${name.toUpperCase().replace(/-/g, "_")}`];
  const json = (name, value) => { if (value === undefined || value === "") return undefined; try { return JSON.parse(value); } catch { throw new Error(`${name} must be valid JSON`); } };
  const options = {
    url: input("url"),
    method: input("method") || undefined,
    body: json("body", input("body")),
    headers: json("headers", input("headers")),
    expect: json("expect", input("expect")),
    mode: (input("mode") || "free").toLowerCase(),
    failOn: (input("fail-on") || "fail").toLowerCase(),
    maxPrice: Number(input("max-price") || 0.05),
    gateway: String(input("gateway") || DEFAULT_GATEWAY).replace(/\/$/, ""),
    payerKey: input("payer-private-key") || env.X402_PAYER_PRIVATE_KEY,
    reportPath: input("report-path") || "x402-preflight-report.json",
  };
  if (!options.url) throw new Error("url is required");
  if (!["free", "paid"].includes(options.mode)) throw new Error("mode must be free or paid");
  if (!["fail", "warn", "never"].includes(options.failOn)) throw new Error("fail-on must be fail, warn, or never");
  if (!(options.maxPrice > 0 && options.maxPrice <= 1)) throw new Error("max-price must be between 0 and 1 USDC");
  if (options.mode === "paid" && !options.payerKey) throw new Error("paid mode needs payer-private-key (store it as a repository secret)");
  return options;
}

async function runFree(options, target) {
  const response = await fetch(`${options.gateway}/preflight/shallow`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(target) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`gateway returned HTTP ${response.status}: ${body.message || body.error || "unknown error"}`);
  return { report: body.audit, settlement: null };
}

async function runPaid(options, target) {
  const [{ wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader }, { ExactEvmScheme }, { privateKeyToAccount }] = await Promise.all([import("@x402/fetch"), import("@x402/evm"), import("viem/accounts")]);
  const account = privateKeyToAccount(options.payerKey.trim());
  const pay = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: PAID_NETWORK, client: new ExactEvmScheme(account) }],
    // Hard cap: never sign more than max-price per call, and only for the default USDC asset.
    spendControls: { maxAmountPerPayment: `$${options.maxPrice}` },
  });
  const response = await pay(`${options.gateway}/api/x402/preflight`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": `ci-${crypto.randomUUID()}` }, body: JSON.stringify(target) });
  const body = await response.json().catch(() => ({}));
  if (response.status !== 200) throw new Error(`paid audit failed with HTTP ${response.status}: ${body.message || body.error || "payment not completed"}`);
  const header = response.headers.get("payment-response");
  return { report: body.result, settlement: header ? decodePaymentResponseHeader(header) : null, payer: account.address };
}

const ICON = { pass: "✅", warn: "⚠️", fail: "❌", info: "ℹ️" };
function renderMarkdown(report, options, settlement) {
  const lines = [`## x402 preflight: ${ICON[report.verdict] || "❔"} ${report.verdict.toUpperCase()} (score ${report.score}/100)`, "", `Target: \`${report.method} ${report.target}\` · mode: **${options.mode}**`, ""];
  lines.push("| | Check | Detail | Fix |", "|---|---|---|---|");
  for (const item of report.checks) lines.push(`| ${ICON[item.status] || ""} | \`${item.id}\` | ${String(item.detail).replace(/\|/g, "\\|")} | ${item.fix ? String(item.fix).replace(/\|/g, "\\|") : ""} |`);
  if (settlement?.transaction) lines.push("", `Paid audit settled on Base: [\`${settlement.transaction.slice(0, 10)}…\`](https://basescan.org/tx/${settlement.transaction})`);
  if (report.upgrade) lines.push("", `> Free shallow audit. Run with \`mode: paid\` for the full audit with a fix for every failure (network, asset, payTo checksum, amount, EIP-712 domain, resource URL, discovery).`);
  return lines.join("\n");
}

export function shouldFail(verdict, failOn) {
  if (failOn === "never") return false;
  if (verdict === "fail") return true;
  return failOn === "warn" && (verdict === "warn" || verdict === "inconclusive");
}

export async function main({ argv, env = process.env, log = console.log } = {}) {
  const options = readOptions(argv, env);
  const target = { url: options.url, ...(options.method ? { method: options.method } : {}), ...(options.headers ? { headers: options.headers } : {}), ...(options.body !== undefined ? { body: options.body } : {}), ...(options.expect ? { expect: options.expect } : {}) };
  const { report, settlement } = options.mode === "paid" ? await runPaid(options, target) : await runFree(options, target);
  const markdown = renderMarkdown(report, options, settlement);
  fs.writeFileSync(options.reportPath, JSON.stringify({ ...report, settlement }, null, 2));
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, [`verdict=${report.verdict}`, `score=${report.score}`, `report-path=${options.reportPath}`, `transaction=${settlement?.transaction || ""}`].join("\n") + "\n");
  log(markdown);
  const failed = shouldFail(report.verdict, options.failOn);
  if (failed && env.GITHUB_ACTIONS) log(`::error::x402 preflight ${report.verdict}: ${report.summary}`);
  return { report, settlement, exitCode: failed ? 1 : 0 };
}

// Resolve symlinks: npx/npm bin shims launch this file through a link on Linux and macOS.
const invokedDirectly = (() => { try { return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invokedDirectly) {
  main().then(({ exitCode }) => process.exit(exitCode)).catch(error => {
    console.error(process.env.GITHUB_ACTIONS ? `::error::${error.message}` : `x402-preflight: ${error.message}`);
    process.exit(2);
  });
}
