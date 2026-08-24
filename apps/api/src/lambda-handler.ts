import { buildApi, type ApiDependencies } from "./app.js";

export interface HttpApiV2Event {
  readonly rawPath?: string;
  readonly rawQueryString?: string;
  readonly requestContext?: { readonly http?: { readonly method?: string } };
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly body?: string | null;
  readonly isBase64Encoded?: boolean;
}
export interface HttpApiV2Response {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}
/** Thin adapter: API Gateway event details never enter domain or application layers. */
export function createLambdaHandler(dependencies: ApiDependencies) {
  let application: Awaited<ReturnType<typeof buildApi>> | undefined;
  const app = async () => {
    application ??= await buildApi(dependencies);
    return application;
  };
  return async (event: HttpApiV2Event): Promise<HttpApiV2Response> => {
    const body =
      event.body === undefined || event.body === null
        ? undefined
        : event.isBase64Encoded
          ? Buffer.from(event.body, "base64")
          : Buffer.from(event.body, "utf8");
    try {
      const response = (await (
        await app()
      ).inject({
        method: (event.requestContext?.http?.method ?? "GET") as never,
        url: `${event.rawPath ?? "/"}${event.rawQueryString ? `?${event.rawQueryString}` : ""}`,
        headers: event.headers as Record<string, string | undefined>,
        payload: body,
      } as never)) as unknown as {
        readonly statusCode: number;
        readonly headers: Readonly<Record<string, string | undefined>>;
        readonly body: string;
      };
      return {
        statusCode: response.statusCode,
        headers: Object.fromEntries(
          Object.entries(response.headers).flatMap(([name, value]) =>
            value === undefined ? [] : [[name, value]],
          ),
        ) as Record<string, string>,
        body: response.body,
      };
    } catch {
      return {
        statusCode: 500,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          error: { code: "INTERNAL_ERROR", message: "Request failed." },
        }),
      };
    }
  };
}
