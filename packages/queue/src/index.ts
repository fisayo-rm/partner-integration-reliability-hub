import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  SQSClient,
  type SQSClientConfig,
} from "@aws-sdk/client-sqs";
import type { QueuePublisher } from "@pirh/application";
import {
  deliverMessageSchema,
  queueMessageSchema,
  resumeDestinationMessageSchema,
  routeEventMessageSchema,
  type QueueMessage,
} from "@pirh/contracts";
import type { JsonObject, OutboxRecord } from "@pirh/domain";

export function createSqsClient(config: SQSClientConfig): SQSClient {
  return new SQSClient(config);
}

export class ElasticMqQueue implements QueuePublisher {
  private queueUrl?: string;
  public constructor(
    private readonly client: SQSClient,
    private readonly queueName: string,
  ) {}
  private async url(): Promise<string> {
    if (this.queueUrl !== undefined) return this.queueUrl;
    const response = await this.client.send(
      new GetQueueUrlCommand({ QueueName: this.queueName }),
    );
    if (response.QueueUrl === undefined)
      throw new Error("Queue URL unavailable.");
    this.queueUrl = response.QueueUrl;
    return this.queueUrl;
  }
  public async publish(input: {
    readonly body: JsonObject;
    readonly delaySeconds?: number;
    readonly traceparent?: string;
  }): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.url(),
        MessageBody: JSON.stringify(input.body),
        ...(input.delaySeconds === undefined
          ? {}
          : { DelaySeconds: input.delaySeconds }),
        ...(input.traceparent === undefined
          ? {}
          : {
              MessageAttributes: {
                traceparent: {
                  DataType: "String",
                  StringValue: input.traceparent,
                },
              },
            }),
      }),
    );
  }
  public async receive(
    max = 1,
    waitSeconds = 5,
    visibilityTimeout = 360,
  ): Promise<readonly Message[]> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: await this.url(),
        MaxNumberOfMessages: max,
        WaitTimeSeconds: waitSeconds,
        VisibilityTimeout: visibilityTimeout,
      }),
    );
    return response.Messages ?? [];
  }
  public async delete(message: Message): Promise<void> {
    if (message.ReceiptHandle === undefined)
      throw new Error("Queue message receipt missing.");
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: await this.url(),
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }
  public async defer(message: Message, delaySeconds: number): Promise<void> {
    if (message.ReceiptHandle === undefined)
      throw new Error("Queue message receipt missing.");
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.url(),
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: Math.max(
          1,
          Math.min(43_200, Math.ceil(delaySeconds)),
        ),
      }),
    );
  }
}

export function outboxQueueMessage(
  record: OutboxRecord,
): QueueMessage | undefined {
  const base = {
    schemaVersion: 1,
    tenantId: record.tenantId,
    ...record.payload,
  };
  if (record.kind === "ROUTE_EVENT")
    return routeEventMessageSchema.parse({
      ...base,
      messageType: "ROUTE_EVENT",
    });
  if (
    record.kind === "DELIVER" ||
    record.kind === "SCHEDULE_DELIVERY" ||
    record.kind === "RESUME_DELIVERY"
  )
    return deliverMessageSchema.parse({
      ...base,
      messageType: "DELIVER",
      cause:
        record.kind === "DELIVER"
          ? (record.payload.cause ?? "INITIAL")
          : (record.payload.cause ?? "RESUME"),
    });
  if (record.kind === "RESUME_DESTINATION")
    return resumeDestinationMessageSchema.parse({
      ...base,
      messageType: "RESUME_DESTINATION",
      cause: "DESTINATION_ENABLED",
    });
  return undefined;
}

export function parseQueueMessage(message: Message): QueueMessage {
  if (typeof message.Body !== "string")
    throw new Error("Queue message body missing.");
  return queueMessageSchema.parse(JSON.parse(message.Body));
}

export async function consumeOne(
  queue: ElasticMqQueue,
  handle: (message: QueueMessage) => Promise<void>,
): Promise<boolean> {
  const [message] = await queue.receive();
  if (message === undefined) return false;
  const parsed = parseQueueMessage(message);
  await handle(parsed);
  await queue.delete(message);
  return true;
}
export {};
