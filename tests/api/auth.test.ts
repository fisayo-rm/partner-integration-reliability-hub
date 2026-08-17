import Fastify from "fastify";
import { expect, test } from "vitest";
import {
  ConsoleAuthenticator,
  ProducerAuthenticator,
  canonicalRequest,
  hmacSignature,
} from "../../packages/auth/src/index.js";
import {
  authenticationErrorHandler,
  consoleAuthenticationHook,
  producerAuthenticationHook,
} from "../../apps/api/src/auth.js";

const tenantId = "tenant_01J0A1B2C3D4E5F6G7H8J9K0MN" as never;
const clientId = "cli_01J0A1B2C3D4E5F6G7H8J9K0MN" as never;
const correlationId = "cor_01J0A1B2C3D4E5F6G7H8J9K0MN" as never;
const timestamp = "1760000000";
const secret = "test secret";
test("test-only Fastify routes establish trusted JWT and HMAC tenant context", async () => {
  const app = Fastify();
  app.setErrorHandler(authenticationErrorHandler);
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (request, body, done) => {
      request.rawBody = body;
      done(null, JSON.parse(body.toString("utf8")));
    },
  );
  app.get(
    "/test/jwt",
    {
      preHandler: consoleAuthenticationHook(
        new ConsoleAuthenticator(
          {
            verifyAccessToken: async () => ({
              issuer: "issuer",
              subject: "subject",
              roles: ["viewer"],
            }),
          },
          {
            findVerifiedIdentity: async () => ({
              issuer: "issuer",
              subject: "subject",
              tenantId,
              status: "active",
              role: "viewer",
              userId: "viewer",
            }),
          },
        ),
      ),
    },
    async (request) => request.tenantContext,
  );
  const producer = new ProducerAuthenticator(
    {
      locateClient: async () => ({ tenantId }),
      getClient: async () => ({
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
        ],
        createdAt: "2026-01-01T00:00:00.000Z" as never,
        version: 1,
      }),
    },
    {
      store: async () => ({ name: "unused" }),
      resolve: async () => ({ value: secret }),
    },
    { putIfAbsent: async () => true },
    () => new Date(Number(timestamp) * 1_000),
  );
  app.post(
    "/test/hmac",
    { preHandler: producerAuthenticationHook(producer, "events:submit") },
    async (request) => request.tenantContext,
  );
  try {
    expect(
      (
        await app.inject({
          url: "/test/jwt",
          headers: { authorization: "Bearer token" },
        })
      ).json(),
    ).toMatchObject({ tenantId, actorType: "console_user", role: "viewer" });
    const raw = Buffer.from('{"event":"test"}');
    const signature = hmacSignature(
      secret,
      canonicalRequest("POST", "/test/hmac", timestamp, "nonce", raw),
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/test/hmac",
          payload: raw,
          headers: {
            "content-type": "application/json",
            "x-client-id": clientId,
            "x-timestamp": timestamp,
            "x-nonce": "nonce",
            "x-signature": signature,
            "x-correlation-id": correlationId,
          },
        })
      ).json(),
    ).toMatchObject({ tenantId, actorType: "api_client" });
  } finally {
    await app.close();
  }
});
