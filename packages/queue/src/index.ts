import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  SQSClient,
  type SQSClientConfig,
} from "@aws-sdk/client-sqs";
import type { QueuePublisher } from "@pirh/application";
import { queueMessageSchema, type QueueMessage } from "@pirh/contracts";
import type { JsonObject } from "@pirh/domain";

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
  public async receive(max = 1, waitSeconds = 5): Promise<readonly Message[]> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: await this.url(),
        MaxNumberOfMessages: max,
        WaitTimeSeconds: waitSeconds,
        VisibilityTimeout: 30,
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
