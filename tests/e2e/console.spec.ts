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

async function signInWithOperator(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.locator("#username").fill("operator@example.test");
  await page.locator("#password").fill("operator-demo-only");
  await page.locator("#kc-login").click();
  await expect(
    page.getByRole("heading", { name: "Operational overview" }),
  ).toBeVisible();
}

async function expireStoredAccessToken(
  page: import("@playwright/test").Page,
  invalidateRefreshToken = false,
) {
  await page.evaluate((invalidate) => {
    const key = Array.from({ length: sessionStorage.length }, (_, index) =>
      sessionStorage.key(index),
    ).find((entry) => entry?.startsWith("oidc.user:") === true);
    if (typeof key !== "string") throw new Error("OIDC user was not stored.");
    const user = JSON.parse(sessionStorage.getItem(key) ?? "{}") as {
      expires_at?: number;
      refresh_token?: string;
    };
    user.expires_at = Math.floor(Date.now() / 1_000) - 1;
    if (invalidate) user.refresh_token = "invalid-refresh-token";
    sessionStorage.setItem(key, JSON.stringify(user));
  }, invalidateRefreshToken);
}

test("M08 console login, role gate, API redaction, and tenant boundary", async ({
  page,
}) => {
  await signInWithOperator(page);
  await expect(page.getByText("operator", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Overview" })).toHaveAttribute(
    "aria-current",
    "page",
  );

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
  const eventBeforeReplay = await request(
    admin,
    `/api/v1/events/${original.eventId}`,
  );
  const eventBeforeReplayBody = (await eventBeforeReplay.json()) as {
    event?: unknown;
    deliveries?: { deliveryId?: string }[];
  };
  const originalBeforeReplay = eventBeforeReplayBody.deliveries?.find(
    (delivery) => delivery.deliveryId === original.deliveryId,
  );
  expect(originalBeforeReplay).toBeDefined();
  await page.goto(`/deliveries/${original.deliveryId}`);
  await expect(
    page.getByRole("heading", { name: "Delivery detail" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Replay delivery" }).click();
  await page
    .getByLabel("Reason")
    .fill("Partner endpoint recovered for M12 replay.");
  const correction = page.getByLabel(/terminal condition was corrected/i);
  if (await correction.isVisible()) await correction.check();
  const replayResponse = page.waitForResponse(
    (response) =>
      response.url().includes(`/deliveries/${original.deliveryId}/replays`) &&
      response.request().method() === "POST" &&
      response.status() === 202,
  );
  await page.getByRole("button", { name: "Confirm replay" }).click();
  await replayResponse;
  await expect(page.getByText(/replay relationships/i)).toBeVisible();
  const eventAfterReplay = await request(
    admin,
    `/api/v1/events/${original.eventId}`,
  );
  const eventAfterReplayBody = (await eventAfterReplay.json()) as {
    event?: unknown;
    deliveries?: { deliveryId?: string }[];
  };
  expect(eventAfterReplayBody.event).toEqual(eventBeforeReplayBody.event);
  expect(
    eventAfterReplayBody.deliveries?.find(
      (delivery) => delivery.deliveryId === original.deliveryId,
    ),
  ).toEqual(originalBeforeReplay);
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

  await page.getByRole("link", { name: "Partners" }).click();
  await expect(
    page.getByRole("heading", { name: "Partner configuration" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Partners" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.locator(".content").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  expect(
    await page.locator(".sidebar").evaluate((element) => {
      const box = element.getBoundingClientRect();
      const shellHeight = element.parentElement?.getBoundingClientRect().height;
      return (
        box.top === 0 && Math.round(box.height) === Math.round(shellHeight ?? 0)
      );
    }),
  ).toBe(true);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("#username")).toBeVisible();
  await page.locator("#username").fill("viewer@example.test");
  await page.locator("#password").fill("viewer-demo-only");
  await page.locator("#kc-login").click();
  await expect(page.getByText("viewer", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Replay delivery" }),
  ).toHaveCount(0);
});

test("M08 console renews an expired access token and ends an invalid session", async ({
  page,
}) => {
  await signInWithOperator(page);
  await expireStoredAccessToken(page);

  const refreshed = page.waitForResponse(
    (response) =>
      response.url().endsWith("/protocol/openid-connect/token") &&
      response.request().method() === "POST" &&
      response.status() === 200,
  );
  await page.reload();
  await refreshed;
  await expect(
    page.getByRole("heading", { name: "Operational overview" }),
  ).toBeVisible();

  await expireStoredAccessToken(page, true);
  await page.reload();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});
