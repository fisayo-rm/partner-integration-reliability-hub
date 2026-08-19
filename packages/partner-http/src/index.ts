import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { PartnerHttpClient } from "@pirh/application";
import { currentTraceparent, withSpan } from "@pirh/observability";
import { redactJson, redactResponseHeaders } from "@pirh/redaction";

export class UnsafeDestinationError extends Error {
  public constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "UnsafeDestinationError";
  }
}
export interface SafePartnerHttpClientConfig {
  readonly mode: "local" | "hosted";
  readonly localHttpHostnames?: readonly string[];
  readonly maxResponseBytes?: number;
  readonly resolve?: (hostname: string) => Promise<readonly string[]>;
}
function privateIp(value: string): boolean {
  if (net.isIP(value) === 4) {
    const [a = -1, b = -1] = value.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const normalized = value.toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("ff")
  );
}
export function captureResponse(input: {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
  readonly redactionPaths?: readonly string[];
}): {
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyExcerpt: string;
  readonly bodyHash: string;
} {
  const headers = redactResponseHeaders(input.headers);
  let bodyExcerpt = input.body.slice(0, 16 * 1024);
  try {
    bodyExcerpt = JSON.stringify(
      redactJson(JSON.parse(bodyExcerpt), input.redactionPaths ?? []),
    );
  } catch {
    // Opaque excerpts are bounded but cannot have path-based redaction applied.
  }
  return {
    headers,
    bodyExcerpt,
    bodyHash: createHash("sha256").update(input.body).digest("hex"),
  };
}
export class SafePartnerHttpClient implements PartnerHttpClient {
  private readonly maxResponseBytes: number;
  public constructor(private readonly config: SafePartnerHttpClientConfig) {
    this.maxResponseBytes = config.maxResponseBytes ?? 64 * 1024;
  }
  public async validateUrl(input: string): Promise<URL> {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new UnsafeDestinationError(
        "INVALID_URL",
        "Destination URL is invalid.",
      );
    }
    if (
      url.username ||
      url.password ||
      url.hash ||
      net.isIP(url.hostname) !== 0
    )
      throw new UnsafeDestinationError(
        "INVALID_URL",
        "Destination URL is unsafe.",
      );
    const local =
      this.config.mode === "local" &&
      url.protocol === "http:" &&
      (this.config.localHttpHostnames ?? []).includes(url.hostname);
    if (url.protocol !== "https:" && !local)
      throw new UnsafeDestinationError(
        "INVALID_SCHEME",
        "Destination scheme is not allowed.",
      );
    const addresses = await this.resolve(url.hostname);
    if (
      addresses.length === 0 ||
      addresses.some((address) => privateIp(address) && !local)
    )
      throw new UnsafeDestinationError(
        "UNSAFE_ADDRESS",
        "Destination address is not allowed.",
      );
    return url;
  }
  private async resolve(hostname: string): Promise<readonly string[]> {
    if (this.config.resolve !== undefined) return this.config.resolve(hostname);
    return (await dnsLookup(hostname, { all: true, verbatim: true })).map(
      (entry) => entry.address,
    );
  }
  public async send(request: {
    readonly url: string;
    readonly method: "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly timeoutMs: number;
    readonly correlationId: string;
  }): Promise<{
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  }> {
    return await withSpan(
      "partner.request",
      { component: "partner-http", correlationId: request.correlationId },
      async () => {
        const url = await this.validateUrl(request.url);
        const addresses = await this.resolve(url.hostname);
        const local =
          this.config.mode === "local" &&
          url.protocol === "http:" &&
          (this.config.localHttpHostnames ?? []).includes(url.hostname);
        if (
          addresses.length === 0 ||
          addresses.some((address) => privateIp(address) && !local)
        )
          throw new UnsafeDestinationError(
            "UNSAFE_ADDRESS",
            "Destination address is not allowed.",
          );
        const address = addresses[0] as string;
        return new Promise((resolve, reject) => {
          const transport = url.protocol === "https:" ? https : http;
          const req = transport.request(
            {
              protocol: url.protocol,
              // Connect to the address just validated instead of resolving the hostname again.
              // This prevents DNS rebinding between validation and the outbound socket.
              hostname: address,
              servername: url.hostname,
              port: url.port || undefined,
              path: `${url.pathname}${url.search}`,
              method: request.method,
              agent: false,
              timeout: request.timeoutMs,
              headers: {
                ...request.headers,
                host: url.host,
                "accept-encoding": "identity",
                "user-agent": "pirh/0.1",
                "x-correlation-id": request.correlationId,
                ...(currentTraceparent() === undefined
                  ? {}
                  : { traceparent: currentTraceparent() }),
              },
            },
            (response) => {
              if (
                response.statusCode !== undefined &&
                response.statusCode >= 300 &&
                response.statusCode < 400
              ) {
                response.resume();
                reject(
                  new UnsafeDestinationError(
                    "REDIRECT",
                    "Partner redirects are not allowed.",
                  ),
                );
                return;
              }
              if (
                response.headers["content-encoding"] !== undefined &&
                response.headers["content-encoding"] !== "identity"
              ) {
                response.resume();
                reject(
                  new UnsafeDestinationError(
                    "ENCODED_RESPONSE",
                    "Encoded partner responses are not allowed.",
                  ),
                );
                return;
              }
              let size = 0;
              const chunks: Buffer[] = [];
              response.on("data", (chunk: Buffer) => {
                size += chunk.length;
                if (size > this.maxResponseBytes) {
                  req.destroy();
                  reject(
                    new UnsafeDestinationError(
                      "RESPONSE_TOO_LARGE",
                      "Partner response exceeds the limit.",
                    ),
                  );
                } else chunks.push(chunk);
              });
              response.on("end", () => {
                const headers: Record<string, string> = {};
                for (const [name, value] of Object.entries(response.headers))
                  if (typeof value === "string") headers[name] = value;
                resolve({
                  status: response.statusCode ?? 0,
                  headers,
                  body: Buffer.concat(chunks).toString("utf8"),
                });
              });
            },
          );
          req.on("timeout", () =>
            req.destroy(
              new UnsafeDestinationError(
                "TIMEOUT",
                "Partner request timed out.",
              ),
            ),
          );
          req.on("error", reject);
          req.end(request.body);
        });
      },
    );
  }
}
