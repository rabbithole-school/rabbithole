#!/usr/bin/env node
// Kit: give a LOCAL Convex deployment the RS256 keypair @convex-dev/auth needs
// (JWT_PRIVATE_KEY + JWKS). A fresh local backend starts with an empty env.
// Usage: node auth-keys.mjs <checkout-dir>   (idempotent; never prints a key)
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";

const cwd = process.argv[2] ?? process.cwd();
const env = { ...process.env, CONVEX_AGENT_MODE: "anonymous" };
const convexEnv = (args, input) =>
  spawnSync("npx", ["convex", "env", ...args], { cwd, env, input, encoding: "utf8" });

const has = (name) => {
  const r = convexEnv(["get", name]);
  return r.status === 0 && r.stdout.trim() !== "";
};
if (has("JWT_PRIVATE_KEY") && has("JWKS")) {
  console.log("auth keys: already set");
  process.exit(0);
}
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString().trimEnd();
const jwks = JSON.stringify({ keys: [{ use: "sig", alg: "RS256", ...publicKey.export({ format: "jwk" }) }] });
// stdin, not argv: the PEM starts with "-" and spans lines.
for (const [name, value] of [["JWT_PRIVATE_KEY", pem], ["JWKS", jwks]]) {
  const r = convexEnv(["set", name], value);
  if (r.status !== 0) {
    console.error(`failed to set ${name}: ${r.stderr}`);
    process.exit(r.status ?? 1);
  }
}
console.log("auth keys: generated and set");
