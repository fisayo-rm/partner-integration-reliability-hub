import { expect, test } from "vitest";

async function handlers() {
  process.env.LOCAL_SECRET_MASTER_KEY_B64 = Buffer.alloc(32, 9).toString(
    "base64",
  );
  const [delivery, outbox, router] = await Promise.all([
    import("../../apps/delivery-worker/src/lambda.js"),
    import("../../apps/outbox-worker/src/lambda.js"),
    import("../../apps/router-worker/src/lambda.js"),
  ]);
  return { delivery, outbox, router };
}

async function publisher() {
  process.env.LOCAL_SECRET_MASTER_KEY_B64 = Buffer.alloc(32, 9).toString(
    "base64",
  );
  return import("../../apps/outbox-worker/src/index.js");
}

const message = {
  schemaVersion: 1,
  messageType: "DELIVER",
  tenantId: "tenant_01J0A1B2C3D4E5F6G7H8J9K0MN",
  eventId: "evt_01J0A1B2C3D4E5F6G7H8J9K0MN",
  deliveryId: "dlv_01J0A1B2C3D4E5F6G7H8J9K0MN",
  correlationId: "cor_01J0A1B2C3D4E5F6G7H8J9K0MN",
  cause: "INITIAL",
};

test("M12 import-safe worker handlers isolate malformed and deferred records", async () => {
  const { delivery: deliveryModule } = await handlers();
  let flushed = 0;
  const delivery = deliveryModule.createSqsHandler({
    deliver: async () => ({ acknowledge: false }),
    resume: async () => undefined,
    flush: async () => {
      flushed += 1;
    },
  });
  const result = await delivery({
    Records: [
      { messageId: "deferred", body: JSON.stringify(message) },
      { messageId: "malformed", body: "{" },
    ],
  });
  expect(
    result.batchItemFailures.map((entry) => entry.itemIdentifier).sort(),
  ).toEqual(["deferred", "malformed"]);
  expect(flushed).toBe(1);
});

test("M12 injected routing and outbox failures report only failed batch records", async () => {
  const { outbox: outboxModule, router: routerModule } = await handlers();
  const router = routerModule.createSqsHandler({
    route: async () => {
      throw new Error("transient DynamoDB failure");
    },
    flush: async () => undefined,
  });
  await expect(
    router({
      Records: [
        {
          messageId: "route",
          body: JSON.stringify({
            schemaVersion: 1,
            messageType: "ROUTE_EVENT",
            tenantId: message.tenantId,
            eventId: message.eventId,
            correlationId: message.correlationId,
            cause: "INITIAL",
          }),
        },
      ],
    }),
  ).resolves.toEqual({ batchItemFailures: [{ itemIdentifier: "route" }] });
  const outbox = outboxModule.createStreamHandler({
    tick: async () => {
      throw new Error("transient SQS failure");
    },
    flush: async () => undefined,
  });
  await expect(outbox({ Records: [{ eventID: "stream-1" }] })).resolves.toEqual(
    {
      batchItemFailures: [{ itemIdentifier: "stream-1" }],
    },
  );
});

test("M12 outbox publisher retries a send/commit crash window without a production fault switch", async () => {
  const { createOutboxPublisher } = await publisher();
  let sends = 0;
  let commits = 0;
  let failures = 0;
  const publish = createOutboxPublisher({
    persistence: {
      markPublished: async () => {
        commits += 1;
        if (commits === 1)
          throw new Error("simulated process crash after send");
      },
      recordPublicationFailure: async () => {
        failures += 1;
      },
      materializeScheduledWork: async () => undefined,
    },
    routing: {
      publish: async () => {
        sends += 1;
      },
    },
    delivery: { publish: async () => undefined },
    local: true,
    scheduleLongDelay: async () => undefined,
    now: () => new Date("2026-08-27T00:00:00.000Z"),
    telemetry: { count: () => undefined, duration: () => undefined },
    logger: { info: () => undefined, error: () => undefined },
  } as never);
  const record = {
    outboxId: "obx_01J0A1B2C3D4E5F6G7H8J9K0MN",
    kind: "ROUTE_EVENT",
    tenantId: message.tenantId,
    aggregateType: "EVENT",
    aggregateId: message.eventId,
    target: "ROUTING_QUEUE",
    payload: {
      eventId: message.eventId,
      correlationId: message.correlationId,
      cause: "INITIAL",
    },
    createdAt: "2026-08-27T00:00:00.000Z",
    attempts: 0,
    schemaVersion: 1,
  } as never;
  await publish(record);
  await publish(record);
  expect({ sends, commits, failures }).toEqual({
    sends: 2,
    commits: 2,
    failures: 1,
  });
});

test("M12 delivery-handler fault injection keeps stale work acknowledged and retryable failures isolated", async () => {
  const { delivery: deliveryModule } = await handlers();
  const failures = [
    "transient DynamoDB failure",
    "transient SQS failure",
    "OAuth timeout",
    "partner timeout",
    "missing secret",
    "circuit finalization conflict",
  ];
  for (const failure of failures) {
    const handler = deliveryModule.createSqsHandler({
      deliver: async () => {
        throw new Error(failure);
      },
      resume: async () => undefined,
      flush: async () => undefined,
    });
    await expect(
      handler({
        Records: [{ messageId: failure, body: JSON.stringify(message) }],
      }),
    ).resolves.toEqual({ batchItemFailures: [{ itemIdentifier: failure }] });
  }
  const stale = deliveryModule.createSqsHandler({
    deliver: async () => ({ acknowledge: true }),
    resume: async () => undefined,
    flush: async () => undefined,
  });
  await expect(
    stale({ Records: [{ messageId: "stale", body: JSON.stringify(message) }] }),
  ).resolves.toEqual({ batchItemFailures: [] });
});
