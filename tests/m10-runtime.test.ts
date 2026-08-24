import { expect, test } from "vitest";
import { SsmParameterSecretStore } from "../packages/secrets/src/index.js";

const context = { tenantId: "tenant_01J0A1B2C3D4E5F6G7H8J9K0MN" } as never;

test("SSM hosted secret store binds aliases without decrypting and resolves immutable versions", async () => {
  const calls: unknown[] = [];
  const client = {
    send: async (command: {
      input: Record<string, unknown>;
      constructor: { name: string };
    }) => {
      calls.push(command);
      if (command.constructor.name === "PutParameterCommand")
        return { Version: 7 };
      return command.input.WithDecryption
        ? { Parameter: { Value: "value", Version: 7 } }
        : { Parameter: { Version: 7 } };
    },
  };
  const store = new SsmParameterSecretStore(client as never);
  expect(
    await store.store(context, { name: "partner-key", value: "value" }),
  ).toEqual({ name: "partner-key", version: "7" });
  expect(await store.isBound(context, "partner-key")).toBe(true);
  expect(
    await store.resolve(context, { name: "partner-key", version: "7" }),
  ).toEqual({ value: "value", version: "7" });
  expect(JSON.stringify(calls)).toContain(
    "/pirh/demo/tenants/tenant_01J0A1B2C3D4E5F6G7H8J9K0MN/secrets/partner-key:7",
  );
  expect(JSON.stringify(calls)).toContain('"WithDecryption":false');
});

test("SSM hosted secret store rejects unsafe parameter aliases", async () => {
  const store = new SsmParameterSecretStore({
    send: async () => ({ Version: 1 }),
  } as never);
  await expect(
    store.store(context, { name: "../escape", value: "value" }),
  ).rejects.toThrow("unsupported characters");
});
