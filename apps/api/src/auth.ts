import type { FastifyRequest, preHandlerHookHandler } from "fastify";
import {
  AuthenticationError,
  ConsoleAuthenticator,
  ProducerAuthenticator,
  type ProducerAuthInput,
} from "@pirh/auth";
import type { TenantContext } from "@pirh/domain";

declare module "fastify" {
  interface FastifyRequest {
    tenantContext?: TenantContext;
    rawBody?: Buffer;
  }
}
function bearer(headers: FastifyRequest["headers"]): string {
  const value = headers.authorization;
  if (typeof value !== "string" || !value.startsWith("Bearer "))
    throw new AuthenticationError();
  return value.slice("Bearer ".length);
}
function singleHeader(
  headers: FastifyRequest["headers"],
  name: string,
): string {
  const value = headers[name];
  if (typeof value !== "string" || value.length === 0)
    throw new AuthenticationError();
  return value;
}
function requestIds(
  request: FastifyRequest,
): Pick<ProducerAuthInput, "requestId" | "correlationId"> {
  return {
    requestId: request.id,
    correlationId:
      `cor_${request.id.slice(4)}` as TenantContext["correlationId"],
  };
}
export function consoleAuthenticationHook(
  authenticator: ConsoleAuthenticator,
): preHandlerHookHandler {
  return async (request) => {
    request.tenantContext = await authenticator.authenticate(
      bearer(request.headers),
      request.id,
      requestIds(request).correlationId,
    );
  };
}
export function producerAuthenticationHook(
  authenticator: ProducerAuthenticator,
  requiredScope: string,
): preHandlerHookHandler {
  return async (request) => {
    const rawBody = request.rawBody ?? Buffer.alloc(0);
    request.tenantContext = await authenticator.authenticate({
      method: request.method,
      path: request.url.split("?", 1)[0] ?? request.url,
      rawBody,
      clientId: singleHeader(request.headers, "x-client-id") as never,
      timestamp: singleHeader(request.headers, "x-timestamp"),
      nonce: singleHeader(request.headers, "x-nonce"),
      signature: singleHeader(request.headers, "x-signature"),
      requiredScope,
      ...requestIds(request),
    });
  };
}
export function authenticationErrorHandler(
  error: unknown,
  _request: FastifyRequest,
  reply: { code(code: number): { send(body: unknown): unknown } },
): unknown {
  if (error instanceof AuthenticationError)
    return reply.code(error.statusCode).send({
      error: {
        code: error.statusCode === 403 ? "FORBIDDEN" : "UNAUTHORIZED",
        message: "Authentication failed.",
      },
    });
  throw error;
}
