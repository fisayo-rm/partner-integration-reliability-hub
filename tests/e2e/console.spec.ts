import { expect, test } from "@playwright/test";

const api = process.env.API_BASE_URL ?? "http://localhost:3000";
const issuer =
  process.env.OIDC_ISSUER ?? "http://localhost:8080/realms/pirh-local";

async function token(username: string, password: string): Promise<string> {
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
  const body = (await response.json()) as { access_token?: string };
  if (!response.ok || body.access_token === undefined)
    throw new Error(`Could not obtain an access token for ${username}.`);
  return body.access_token;
}

async function request(
  tokenValue: string,
  path: string,
  init: RequestInit = {},
) {
  return fetch(`${api}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${tokenValue}`,
      ...(init.headers ?? {}),
    },
  });
}

test("M08 console login, role gate, API redaction, and tenant boundary", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.locator("#username").fill("operator@example.test");
  await page.locator("#password").fill("operator-demo-only");
  await page.locator("#kc-login").click();
  await expect(
    page.getByRole("heading", { name: "Operational overview" }),
  ).toBeVisible();
  await expect(page.getByText("operator", { exact: true })).toBeVisible();

  const [admin, viewer, otherTenant] = await Promise.all([
    token("admin@example.test", "admin-demo-only"),
    token("viewer@example.test", "viewer-demo-only"),
    token("other-tenant-viewer@example.test", "other-viewer-demo-only"),
  ]);
  const destinations = await request(admin, "/api/v1/destinations?limit=100");
  expect(destinations.ok).toBeTruthy();
  const destinationBody = await destinations.json();
  const serialized = JSON.stringify(destinationBody);
  expect(serialized).not.toContain(
    process.env.LOCAL_SEED_ALPHA_API_KEY ?? "not-a-secret",
  );
  expect(serialized).not.toContain(
    process.env.LOCAL_SEED_BETA_CLIENT_SECRET ?? "not-a-secret",
  );

  const terminal = await request(
    admin,
    "/api/v1/deliveries?terminalFailure=true",
  );
  const terminalBody = (await terminal.json()) as {
    items?: {
      deliveryId: string;
      eventId: string;
      executionType?: string;
      state?: string;
    }[];
  };
  const original = terminalBody.items?.find(
    (item: { executionType?: string; state?: string }) =>
      item.executionType === "ORIGINAL" && item.state === "dead_lettered",
  );
  expect(original).toBeDefined();
  if (original === undefined)
    throw new Error("Expected M06 dead-letter delivery.");
  const viewerReplay = await request(
    viewer,
    `/api/v1/deliveries/${original.deliveryId}/replays`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({ reason: "viewer replay must be forbidden" }),
    },
  );
  expect(viewerReplay.status).toBe(403);

  const crossTenant = await request(
    otherTenant,
    `/api/v1/events/${original.eventId}`,
  );
  expect(crossTenant.status).toBe(404);
  const validation = await request(admin, "/api/v1/transformations/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      definition: {
        schemaVersion: 1,
        contentType: "application/json",
        mappings: [{ target: "$.eventType", source: "$.eventType" }],
      },
      sampleEvent: {},
    }),
  });
  expect(validation.ok).toBeTruthy();
});
