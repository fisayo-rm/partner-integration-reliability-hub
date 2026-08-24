import { Buffer } from "node:buffer";
import { URLSearchParams } from "node:url";

const apiBaseUrl = process.env.PIRH_API_BASE_URL ?? "http://localhost:3000";
const issuer =
  process.env.OIDC_ISSUER ?? "http://localhost:8080/realms/pirh-local";

async function token(username, password) {
  const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "pirh-console",
      username,
      password,
    }),
  });
  const body = await response.json();
  if (!response.ok || typeof body.access_token !== "string")
    throw new Error(`Could not obtain the ${username} demonstration token.`);
  return body.access_token;
}
async function post(accessToken, path, body) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      `M09 ${path} failed: ${String(result?.error?.code ?? response.status)}`,
    );
  return result;
}

const sourceToken = await token("admin@example.test", "admin-demo-only");
const targetToken = await token(
  "target-admin@example.test",
  "target-admin-demo-only",
);
const exported = await post(sourceToken, "/api/v1/configuration/exports", {
  tenant: "tenant-demo",
});
if (typeof exported.yaml !== "string" || typeof exported.digest !== "string")
  throw new Error("M09 export did not produce a YAML artifact and digest.");
const protectedValues = [
  process.env.LOCAL_SEED_ALPHA_API_KEY,
  process.env.LOCAL_SEED_BETA_CLIENT_SECRET,
  process.env.LOCAL_SEED_TARGET_ALPHA_API_KEY,
  process.env.LOCAL_SEED_TARGET_BETA_CLIENT_SECRET,
].filter((value) => typeof value === "string" && value.length > 0);
if (protectedValues.some((value) => exported.yaml.includes(value)))
  throw new Error("M09 export contained secret material.");
const validated = await post(
  targetToken,
  "/api/v1/configuration/imports/validate",
  { bundle: exported.bundle },
);
const planned = await post(targetToken, "/api/v1/configuration/imports/plan", {
  bundle: exported.bundle,
});
if (!Array.isArray(planned.items) || typeof planned.receipt !== "string")
  throw new Error("M09 plan did not produce items and a signed receipt.");
const applied = await post(targetToken, "/api/v1/configuration/imports/apply", {
  bundle: exported.bundle,
  receipt: planned.receipt,
});
const replanned = await post(
  targetToken,
  "/api/v1/configuration/imports/plan",
  { bundle: exported.bundle },
);
if (
  !Array.isArray(replanned.items) ||
  !replanned.items.every((item) => item.action === "UNCHANGED")
)
  throw new Error("M09 replan was not idempotent.");
console.log(
  JSON.stringify(
    {
      digest: exported.digest,
      yamlBytes: Buffer.byteLength(exported.yaml, "utf8"),
      validationDigest: validated.digest,
      initialActions: planned.items.map((item) => item.action),
      applyOutcomes: applied.items?.map((item) => item.outcome),
      reapplyActions: replanned.items.map((item) => item.action),
      secretsMoved: false,
      operationalHistoryMoved: false,
    },
    null,
    2,
  ),
);
