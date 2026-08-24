import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { ApiClient, ActorRole, TenantContext } from "@pirh/domain";
import type {
  ApiClientRepository,
  IdentityProvider,
  IdentityRepository,
  NonceRepository,
  SecretStore,
} from "@pirh/application";

export class AuthenticationError extends Error {
  public constructor(readonly statusCode: 401 | 403 = 401) {
    super("Authentication failed.");
  }
}
export interface VerifiedAccessToken {
  readonly issuer: string;
  readonly subject: string;
  readonly roles: readonly string[];
}
export interface OidcVerifierConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUri: string;
  readonly allowedAlgorithms: readonly string[];
  readonly tokenUseClaim?: string;
  readonly tokenUseValue?: string;
  readonly roleClaim?: string;
  /** Cognito access tokens identify a public app client through client_id, not aud. */
  readonly audienceClaim?: string;
}
function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
export class OidcAccessTokenVerifier implements IdentityProvider {
  private readonly jwks;
  public constructor(private readonly config: OidcVerifierConfig) {
    this.jwks = createRemoteJWKSet(new URL(config.jwksUri));
  }
  public async verifyAccessToken(token: string): Promise<VerifiedAccessToken> {
    try {
      const verified = await jwtVerify(token, this.jwks, {
        issuer: this.config.issuer,
        algorithms: [...this.config.allowedAlgorithms],
      });
      const audience = verified.payload[this.config.audienceClaim ?? "aud"];
      const audiences =
        typeof audience === "string"
          ? [audience]
          : Array.isArray(audience)
            ? audience.filter(
                (value): value is string => typeof value === "string",
              )
            : [];
      if (!audiences.includes(this.config.audience))
        throw new AuthenticationError();
      if (
        this.config.tokenUseClaim !== undefined &&
        verified.payload[this.config.tokenUseClaim] !==
          this.config.tokenUseValue
      )
        throw new AuthenticationError();
      const subject = verified.payload.sub;
      if (typeof subject !== "string" || subject.length === 0)
        throw new AuthenticationError();
      const roles = stringArray(
        verified.payload[this.config.roleClaim ?? "roles"],
      );
      return { issuer: this.config.issuer, subject, roles };
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      throw new AuthenticationError();
    }
  }
}
export class ConsoleAuthenticator {
  public constructor(
    private readonly verifier: IdentityProvider,
    private readonly identities: IdentityRepository,
  ) {}
  public async authenticate(
    token: string,
    requestId: string,
    correlationId: TenantContext["correlationId"],
  ): Promise<TenantContext> {
    const verified = await this.verifier.verifyAccessToken(token);
    const mapping = await this.identities.findVerifiedIdentity(
      verified.issuer,
      verified.subject,
    );
    if (mapping === undefined || mapping.status !== "active")
      throw new AuthenticationError();
    return {
      tenantId: mapping.tenantId,
      actorType: "console_user",
      actorId: mapping.userId,
      role: mapping.role,
      requestId,
      correlationId,
    };
  }
}
export function canonicalRequest(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  rawBody: Uint8Array,
): string {
  return [
    method.toUpperCase(),
    path,
    timestamp,
    nonce,
    createHash("sha256").update(rawBody).digest("hex"),
  ].join("\n");
}
export function decodeTimestamp(
  value: string,
  now: Date,
  maxSkewSeconds = 300,
): Date {
  if (!/^[0-9]{1,12}$/.test(value)) throw new AuthenticationError();
  const seconds = Number(value);
  const parsed = new Date(seconds * 1_000);
  if (
    !Number.isSafeInteger(seconds) ||
    Math.abs(now.getTime() - parsed.getTime()) > maxSkewSeconds * 1_000
  )
    throw new AuthenticationError();
  return parsed;
}
export function hmacSignature(secret: string, canonical: string): string {
  return createHmac("sha256", secret).update(canonical).digest("base64url");
}
export function signaturesMatch(expected: string, received: string): boolean {
  const expectedBuffer = Buffer.from(expected, "base64url");
  const receivedBuffer = Buffer.from(received, "base64url");
  const sameLength = expectedBuffer.length === receivedBuffer.length;
  const padded = sameLength
    ? receivedBuffer
    : Buffer.alloc(expectedBuffer.length);
  return timingSafeEqual(expectedBuffer, padded) && sameLength;
}
export interface ProducerAuthInput {
  readonly method: string;
  readonly path: string;
  readonly rawBody: Uint8Array;
  readonly clientId: ApiClient["clientId"];
  readonly timestamp: string;
  readonly nonce: string;
  readonly signature: string;
  readonly requiredScope: string;
  readonly requestId: string;
  readonly correlationId: TenantContext["correlationId"];
}
export class ProducerAuthenticator {
  public constructor(
    private readonly clients: ApiClientRepository,
    private readonly secrets: SecretStore,
    private readonly nonces: NonceRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  public async authenticate(input: ProducerAuthInput): Promise<TenantContext> {
    decodeTimestamp(input.timestamp, this.clock());
    const locator = await this.clients.locateClient(input.clientId);
    if (locator === undefined) throw new AuthenticationError();
    const provisional: TenantContext = {
      tenantId: locator.tenantId,
      actorType: "api_client",
      actorId: input.clientId,
      requestId: input.requestId,
      correlationId: input.correlationId,
    };
    const client = await this.clients.getClient(provisional, input.clientId);
    if (
      client === undefined ||
      client.status !== "active" ||
      !client.scopes.includes(input.requiredScope)
    )
      throw new AuthenticationError();
    const canonical = canonicalRequest(
      input.method,
      input.path,
      input.timestamp,
      input.nonce,
      input.rawBody,
    );
    let valid = false;
    for (const version of client.secretVersions) {
      if (
        version.state === "grace" &&
        (version.graceExpiresAt === undefined ||
          new Date(version.graceExpiresAt).getTime() <= this.clock().getTime())
      )
        continue;
      try {
        const resolved = await this.secrets.resolve(
          provisional,
          version.reference,
        );
        valid =
          signaturesMatch(
            hmacSignature(resolved.value, canonical),
            input.signature,
          ) || valid;
      } catch {
        /* Resolve failures are deliberately indistinguishable from invalid credentials. */
      }
    }
    if (!valid) throw new AuthenticationError();
    const nonceHash = createHash("sha256").update(input.nonce).digest("hex");
    const inserted = await this.nonces.putIfAbsent({
      tenantId: locator.tenantId,
      clientId: input.clientId,
      nonceHash,
      expiresAt: new Date(this.clock().getTime() + 300_000),
    });
    if (!inserted) throw new AuthenticationError();
    return provisional;
  }
}
const rank: Readonly<Record<ActorRole, number>> = {
  viewer: 1,
  operator: 2,
  admin: 3,
};
export function requireRole(context: TenantContext, required: ActorRole): void {
  if (
    context.actorType !== "console_user" ||
    context.role === undefined ||
    rank[context.role] < rank[required]
  )
    throw new AuthenticationError(403);
}
