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
  return async (event: HttpApiV2Event): Promise<HttpApiV2Response> => {
    const app = await buildApi(dependencies);
    try {
      const response = (await app.inject({
        method: (event.requestContext?.http?.method ?? "GET") as never,
        url: `${event.rawPath ?? "/"}${event.rawQueryString ? `?${event.rawQueryString}` : ""}`,
        headers: event.headers as Record<string, string | undefined>,
        payload: event.body ?? undefined,
      } as never)) as unknown as {
        readonly statusCode: number;
        readonly headers: Readonly<Record<string, string | undefined>>;
        readonly body: string;
      };
      return {
        statusCode: response.statusCode,
        headers: {
          "content-type":
            response.headers["content-type"] ?? "application/json",
        },
        body: response.body,
      };
    } finally {
      await app.close();
    }
  };
}
