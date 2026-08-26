import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { buildMockPartnerAlpha } from "./index.js";

interface FunctionUrlEvent {
  readonly rawPath?: string;
  readonly rawQueryString?: string;
  readonly requestContext?: { readonly http?: { readonly method?: string } };
  readonly headers?: Record<string, string | undefined>;
  readonly body?: string | null;
  readonly isBase64Encoded?: boolean;
}
let app: ReturnType<typeof buildMockPartnerAlpha> | undefined;
let configuration:
  | { readonly apiKey: string; readonly controlToken: string }
  | undefined;
async function value(name: string) {
  const parameter = await new SSMClient({
    region: process.env.AWS_REGION ?? "us-east-1",
  }).send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  if (parameter.Parameter?.Value === undefined)
    throw new Error("Mock parameter unavailable.");
  return parameter.Parameter.Value;
}
export async function functionUrlHandler(event: FunctionUrlEvent): Promise<{
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: string;
}> {
  const nextConfiguration = {
    apiKey: await value(String(process.env.MOCK_ALPHA_API_KEY_PARAMETER)),
    controlToken: await value(String(process.env.MOCK_CONTROL_TOKEN_PARAMETER)),
  };
  if (
    app === undefined ||
    configuration?.apiKey !== nextConfiguration.apiKey ||
    configuration.controlToken !== nextConfiguration.controlToken
  ) {
    app = buildMockPartnerAlpha(nextConfiguration);
    configuration = nextConfiguration;
  }
  const response = await (
    app.inject as unknown as (input: unknown) => Promise<{
      statusCode: number;
      headers: Record<string, string | string[] | number | undefined>;
      body: string;
    }>
  )({
    method: (event.requestContext?.http?.method ?? "GET") as never,
    url: `${event.rawPath ?? "/"}${event.rawQueryString ? `?${event.rawQueryString}` : ""}`,
    ...(event.headers === undefined ? {} : { headers: event.headers }),
    ...(event.body === undefined || event.body === null
      ? {}
      : {
          payload: event.isBase64Encoded
            ? Buffer.from(event.body, "base64")
            : event.body,
        }),
  });
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body: response.body,
  };
}
