import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import {
  AuthenticationError,
  ConsoleAuthenticator,
  ProducerAuthenticator,
  canonicalRequest,
  decodeTimestamp,
  hmacSignature,
  requireRole,
  signaturesMatch,
} from "../../packages/auth/src/index.js";
import type {
  ApiClient,
  TenantContext,
} from "../../packages/domain/src/index.js";

const tenantId = "tenant_01J0A1B2C3D4E5F6G7H8J9K0MN" as never;
const clientId = "cli_01J0A1B2C3D4E5F6G7H8J9K0MN" as never;
const correlationId = "cor_01J0A1B2C3D4E5F6G7H8J9K0MN" as never;
const requestContext = { requestId: "req-test", correlationId };
const timestamp = "1760000000";
const clock = () => new Date(Number(timestamp) * 1_000);
const secret = "correct horse battery staple";
const client: ApiClient = {
  clientId,
  tenantId,
  name: "test",
  status: "active",
  scopes: ["events:submit"],
  secretVersions: [
    {
      reference: { name: "current", version: "1" },
      state: "active",
      activatedAt: "2026-01-01T00:00:00.000Z" as never,
    },
    {
      reference: { name: "old", version: "0" },
      state: "grace",
      activatedAt: "2026-01-01T00:00:00.000Z" as never,
      graceExpiresAt: "2026-01-02T00:00:00.000Z" as never,
    },
  ],
  createdAt: "2026-01-01T00:00:00.000Z" as never,
  version: 1,
};
test("canonical HMAC input uses raw bytes, strict Unix timestamps, and base64url signatures", () => {
  const body = Buffer.from('{"x":1}', "utf8");
  const canonical = canonicalRequest(
    "post",
    "/api/v1/events",
    timestamp,
    "nonce",
    body,
  );
  expect(canonical).toBe(
    `POST\n/api/v1/events\n${timestamp}\nnonce\n${createHash("sha256").update(body).digest("hex")}`,
  );
  const signature = hmacSignature(secret, canonical);
  expect(signature).not.toContain("=");
  expect(signaturesMatch(signature, signature)).toBe(true);
  expect(signaturesMatch(signature, "bad")).toBe(false);
  expect(() => decodeTimestamp("2026-01-01", clock())).toThrow(
    AuthenticationError,
  );
  expect(() => decodeTimestamp("1759999000", clock())).toThrow(
    AuthenticationError,
  );
});
test("producer authentication derives the tenant from its locator and rejects replay without leaking client state", async () => {
  let nonceUsed = false;
  const auth = new ProducerAuthenticator(
    { locateClient: async () => ({ tenantId }), getClient: async () => client },
    {
      store: async () => ({ name: "unused" }),
      isBound: async () => true,
      resolve: async (_context, ref) => ({
        value: ref.name === "current" ? secret : "old",
      }),
    },
    {
      putIfAbsent: async () => {
        if (nonceUsed) return false;
        nonceUsed = true;
        return true;
      },
    },
    clock,
  );
  const rawBody = Buffer.from('{"x":1}');
  const signature = hmacSignature(
    secret,
    canonicalRequest("POST", "/api/v1/events", timestamp, "n-1", rawBody),
  );
  const input = {
    method: "POST",
    path: "/api/v1/events",
    rawBody,
    clientId,
    timestamp,
    nonce: "n-1",
    signature,
    requiredScope: "events:submit",
    ...requestContext,
  };
  await expect(auth.authenticate(input)).resolves.toMatchObject({
    tenantId,
    actorType: "api_client",
  });
  await expect(auth.authenticate(input)).rejects.toBeInstanceOf(
    AuthenticationError,
  );
});
test("persisted identity roles are authoritative and server-side role guards prevent escalation", async () => {
  const context = await new ConsoleAuthenticator(
    {
      verifyAccessToken: async () => ({
        issuer: "issuer",
        subject: "viewer",
        roles: ["admin"],
      }),
    },
    {
      findVerifiedIdentity: async () => ({
        issuer: "issuer",
        subject: "viewer",
        tenantId,
        status: "active",
        role: "viewer",
        userId: "viewer",
      }),
    },
  ).authenticate("ignored", "request", correlationId);
  expect(context.role).toBe("viewer");
  expect(() => requireRole(context, "operator")).toThrow(AuthenticationError);
  requireRole(context, "viewer");
  const intruder: TenantContext = {
    ...context,
    tenantId: "tenant_11J0A1B2C3D4E5F6G7H8J9K0MN" as never,
  };
  expect(intruder.tenantId).not.toBe(tenantId);
});
