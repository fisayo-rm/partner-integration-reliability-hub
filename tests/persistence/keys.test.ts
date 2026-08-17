import { expect, test } from "vitest";
import { key, stableShard } from "../../packages/persistence/src/index.js";

const tenant = "tenant_01J0A1B2C3D4E5F6G7H8J9K0MN" as never;
const client = "cli_01J0A1B2C3D4E5F6G7H8J9K0MN" as never;
test("M02 key builders cover every core and audit access-pattern family", () => {
  expect(key.tenant(tenant)).toEqual({ PK: `TENANT#${tenant}`, SK: "META" });
  expect(key.identity("issuer", "subject").PK).toMatch(
    /^IDENTITY#[a-f0-9]{64}#subject$/,
  );
  expect(key.apiClient(tenant, client).SK).toBe(`API_CLIENT#${client}`);
  expect(key.apiClientLocator(client)).toEqual({
    PK: `API_CLIENT#${client}`,
    SK: "LOCATOR",
  });
  expect(key.partner(tenant, "ptr_1").SK).toBe("PARTNER#ptr_1");
  expect(key.destination(tenant, "dst_1").SK).toBe("DESTINATION#dst_1");
  expect(key.runtime(tenant, "dst_1", "CIRCUIT").SK).toBe("RUNTIME#CIRCUIT");
  expect(key.transformation(tenant, "trf_1", 7).SK).toBe("VERSION#00000007");
  expect(
    key.subscription(tenant, "shipment.status_changed", "dst_1").PK,
  ).toContain("EVENT_TYPE#shipment.status_changed");
  expect(key.event(tenant, "evt_1").PK).toContain("EVENT#evt_1");
  expect(key.delivery(tenant, "evt_1", "dlv_1").SK).toBe("DELIVERY#dlv_1");
  expect(key.attempt(tenant, "evt_1", "dlv_1", 2).SK).toBe(
    "DELIVERY#dlv_1#ATTEMPT#00000002",
  );
  expect(key.history(tenant, "evt_1", "dlv_1", "time", "h").SK).toBe(
    "DELIVERY#dlv_1#HISTORY#time#h",
  );
  expect(key.lookup(tenant, "CORRELATION", "cor_1").PK).toBe(
    `TENANT#${tenant}#LOOKUP`,
  );
  expect(key.idempotency(tenant, client, "hash").SK).toBe("KEY#hash");
  expect(key.nonce(tenant, client, "hash").SK).toBe("NONCE#hash");
  expect(key.eventIndex(tenant, "ALL", "time", "evt_1").PK).toContain(
    "EVENT_INDEX#ALL",
  );
  expect(
    key.deliveryIndex(tenant, "STATUS#succeeded", "time", "dlv_1").PK,
  ).toContain("DELIVERY_INDEX#STATUS#succeeded");
  expect(key.rollup(tenant, "2026081709", 2).PK).toContain("SHARD#2");
  expect(key.outbox(3, "time", "obx_1").PK).toBe("OUTBOX#3");
  expect(key.audit(tenant, "time", "aud_1").SK).toBe("time#AUDIT#aud_1");
  expect(key.secret(tenant, "partner", "v1").SK).toBe(
    "SECRET#partner#VERSION#v1",
  );
  expect(stableShard("obx_1", 8)).toBe(stableShard("obx_1", 8));
});
