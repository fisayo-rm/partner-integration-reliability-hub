import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Link,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useParams,
} from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserManager, WebStorageStateStore, type User } from "oidc-client-ts";
import type {
  DestinationHealthResponse,
  PaginatedResponse,
  ReplayEligibilityResponse,
  SessionResponse,
  TransformationSummaryResponse,
} from "@pirh/contracts";

type Role = SessionResponse["role"];
type JsonRecord = Record<string, unknown>;

interface EventRecord extends JsonRecord {
  readonly eventId: string;
  readonly correlationId: string;
  readonly eventType: string;
  readonly acceptedAt: string;
  readonly status: string;
}
interface DeliveryRecord extends JsonRecord {
  readonly deliveryId: string;
  readonly eventId: string;
  readonly correlationId: string;
  readonly partnerId: string;
  readonly destinationId: string;
  readonly state: string;
  readonly executionType: "ORIGINAL" | "REPLAY";
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly lastFailureCategory?: string;
  readonly updatedAt: string;
}
interface DestinationRecord extends JsonRecord {
  readonly destinationId: string;
  readonly partnerId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly authType: string;
  readonly authConfiguration?: JsonRecord;
  readonly credential?: {
    readonly alias?: string;
    readonly configured: boolean;
  };
  readonly baseUrl: string;
  readonly path: string;
  readonly version: number;
  readonly retryPolicy: JsonRecord;
  readonly rateLimitPolicy: JsonRecord;
  readonly circuitBreakerPolicy: JsonRecord;
  readonly circuit?: DestinationHealthResponse;
}
interface PartnerRecord extends JsonRecord {
  readonly partnerId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly version: number;
}
interface AttemptRecord extends JsonRecord {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly outcome: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly failureCategory?: string;
}
interface HistoryRecord extends JsonRecord {
  readonly historyId: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly summary: string;
}
interface DeliveryDetail {
  readonly delivery: DeliveryRecord;
  readonly attempts: readonly AttemptRecord[];
  readonly history: readonly HistoryRecord[];
  readonly replayRelations: readonly JsonRecord[];
  readonly replayEligibility: ReplayEligibilityResponse;
}
interface EventDetail {
  readonly event: EventRecord;
  readonly deliveries: readonly DeliveryRecord[];
  readonly replayRelations: readonly JsonRecord[];
}
interface Overview {
  readonly from: string;
  readonly to: string;
  readonly totals: Record<string, number>;
  readonly retryingCount: number;
  readonly averageLatencyMs: number;
  readonly destinations: readonly {
    readonly destinationId: string;
    readonly partnerId: string;
    readonly name: string;
    readonly enabled: boolean;
    readonly circuit: DestinationHealthResponse;
    readonly totals: Record<string, number>;
    readonly averageLatencyMs: number;
  }[];
}
interface AuditRecord extends JsonRecord {
  readonly auditId: string;
  readonly actorId: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly occurredAt: string;
  readonly reason?: string;
}

const config = {
  apiBase: (
    import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000"
  ).replace(/\/$/, ""),
  authority:
    import.meta.env.VITE_OIDC_AUTHORITY ??
    "http://localhost:8080/realms/pirh-local",
  clientId: import.meta.env.VITE_OIDC_CLIENT_ID ?? "pirh-console",
};

const manager = new UserManager({
  authority: config.authority,
  client_id: config.clientId,
  redirect_uri: `${window.location.origin}/auth/callback`,
  post_logout_redirect_uri: `${window.location.origin}/login`,
  response_type: "code",
  scope: "openid profile email",
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),
  stateStore: new WebStorageStateStore({ store: window.sessionStorage }),
  automaticSilentRenew: false,
  monitorSession: false,
});

class ApiRequestError extends Error {
  public constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function api<T>(
  token: string,
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${config.apiBase}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...(options.headers ?? {}),
    },
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body: unknown = contentType.includes("application/json")
    ? await response.json()
    : undefined;
  if (!response.ok) {
    const error = body as {
      error?: { code?: unknown; message?: unknown; requestId?: unknown };
    };
    throw new ApiRequestError(
      response.status,
      typeof error.error?.code === "string"
        ? error.error.code
        : "REQUEST_FAILED",
      typeof error.error?.message === "string"
        ? error.error.message
        : "The request could not be completed.",
      typeof error.error?.requestId === "string"
        ? error.error.requestId
        : undefined,
    );
  }
  return body as T;
}

function query(values: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== "") params.set(key, value);
  const encoded = params.toString();
  return encoded === "" ? "" : `?${encoded}`;
}

function dateRange(): Record<string, string> {
  const to = new Date();
  const from = new Date(to.getTime() - 24 * 3_600_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

interface AuthValue {
  readonly token?: string | undefined;
  readonly session?: SessionResponse | undefined;
  readonly ready: boolean;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
}
const AuthContext = createContext<AuthValue | undefined>(undefined);

function AuthProvider({ children }: { readonly children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<SessionResponse>();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void manager
      .getUser()
      .then((value) => {
        setUser(value?.expired ? null : (value ?? null));
      })
      .finally(() => setReady(true));
    const callback = (value: User) => setUser(value);
    manager.events.addUserLoaded(callback);
    return () => manager.events.removeUserLoaded(callback);
  }, []);
  useEffect(() => {
    if (user?.access_token === undefined) {
      setSession(undefined);
      return;
    }
    void api<SessionResponse>(user.access_token, "/api/v1/session")
      .then(setSession)
      .catch(() => setSession(undefined));
  }, [user?.access_token]);
  const value = useMemo<AuthValue>(
    () => ({
      token: user?.access_token,
      session,
      ready,
      signIn: () => manager.signinRedirect({ prompt: "login" }),
      signOut: () => manager.signoutRedirect(),
    }),
    [ready, session, user?.access_token],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (value === undefined) throw new Error("AuthProvider is required.");
  return value;
}

function useToken(): string {
  const { token } = useAuth();
  if (token === undefined) throw new Error("A session is required.");
  return token;
}

function canMutate(role: Role | undefined): boolean {
  return role === "admin";
}
function canReplay(role: Role | undefined): boolean {
  return role === "admin" || role === "operator";
}
function statusTone(
  value: string,
): "success" | "warning" | "danger" | "neutral" {
  if (value === "succeeded" || value === "CLOSED" || value === "success")
    return "success";
  if (value.includes("failed") || value.includes("dead") || value === "OPEN")
    return "danger";
  if (
    value.includes("retry") ||
    value.includes("rate") ||
    value === "HALF_OPEN"
  )
    return "warning";
  return "neutral";
}
function Status({ value }: { readonly value: string }) {
  return (
    <span className={`status status-${statusTone(value)}`}>
      {value.replaceAll("_", " ")}
    </span>
  );
}
function formatDate(value: unknown): string {
  if (typeof value !== "string") return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
function number(value: unknown): string {
  return new Intl.NumberFormat().format(typeof value === "number" ? value : 0);
}
function ErrorNotice({ error }: { readonly error: unknown }) {
  if (error === null || error === undefined) return null;
  const value = error instanceof ApiRequestError ? error : undefined;
  return (
    <div className="notice notice-error" role="alert">
      <strong>{value?.code ?? "Request failed"}</strong>{" "}
      {value?.message ?? "Please retry."}
      {value?.requestId === undefined ? null : (
        <small> Request {value.requestId}</small>
      )}
    </div>
  );
}
function QueryState({
  loading,
  error,
  empty,
  children,
}: {
  readonly loading: boolean;
  readonly error: unknown;
  readonly empty: boolean;
  readonly children: ReactNode;
}) {
  if (loading) return <p className="state">Loading operational data…</p>;
  if (error !== null && error !== undefined)
    return <ErrorNotice error={error} />;
  if (empty) return <p className="state">No matching records.</p>;
  return <>{children}</>;
}
function JsonView({
  value,
  label,
}: {
  readonly value: unknown;
  readonly label: string;
}) {
  return (
    <section className="json-view" aria-label={label}>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </section>
  );
}
function PageHeader({
  title,
  children,
}: {
  readonly title: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
      </div>
      {children === undefined ? null : (
        <div className="page-actions">{children}</div>
      )}
    </div>
  );
}

function Login() {
  const { signIn } = useAuth();
  return (
    <main className="login-shell">
      <section className="login-card">
        <p className="eyebrow">Partner Integration Reliability Hub</p>
        <h1>Operations console</h1>
        <p>
          Investigate deliveries, recover safely, and manage partner
          configuration.
        </p>
        <button className="button button-primary" onClick={() => void signIn()}>
          Sign in
        </button>
      </section>
    </main>
  );
}
function AuthCallback() {
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    void manager
      .signinRedirectCallback()
      .then(() => navigate("/overview", { replace: true }))
      .catch(setError);
  }, [navigate]);
  return (
    <main className="login-shell">
      {error === undefined ? (
        <p>Completing sign-in…</p>
      ) : (
        <ErrorNotice error={error} />
      )}
    </main>
  );
}
function Protected({ children }: { readonly children: ReactNode }) {
  const { ready, token, session } = useAuth();
  if (!ready)
    return (
      <main className="login-shell">
        <p>Loading session…</p>
      </main>
    );
  if (token === undefined) return <Navigate to="/login" replace />;
  if (session === undefined)
    return (
      <main className="login-shell">
        <p>Authorizing session…</p>
      </main>
    );
  return <>{children}</>;
}

const nav = [
  ["/overview", "Overview"],
  ["/events", "Events"],
  ["/deliveries", "Deliveries"],
  ["/dead-letters", "Dead letters"],
  ["/partners", "Partners"],
  ["/audit", "Audit"],
] as const;
function Shell({ children }: { readonly children: ReactNode }) {
  const { session, signOut } = useAuth();
  return (
    <div className="shell">
      <aside className="sidebar">
        <Link to="/overview" className="brand">
          Reliability <span>Hub</span>
        </Link>
        <nav aria-label="Operations navigation">
          {nav.map(([to, label]) => (
            <Link key={to} to={to}>
              {label}
            </Link>
          ))}
        </nav>
        <div className="session">
          <span>{session?.actorId}</span>
          <Status value={session?.role ?? "viewer"} />
          <button
            className="button button-quiet"
            onClick={() => void signOut()}
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}

function OverviewPage() {
  const token = useToken();
  const range = useMemo(dateRange, []);
  const data = useQuery({
    queryKey: ["overview", range],
    queryFn: () =>
      api<Overview>(token, `/api/v1/operational-rollups${query(range)}`),
    refetchInterval: 10_000,
  });
  const totals = data.data?.totals ?? {};
  const completed =
    (totals.deliverySuccesses ?? 0) + (totals.deliveryFailures ?? 0);
  const successRate =
    completed === 0 ? 0 : ((totals.deliverySuccesses ?? 0) / completed) * 100;
  return (
    <>
      <PageHeader title="Operational overview">
        <button className="button" onClick={() => void data.refetch()}>
          Refresh
        </button>
      </PageHeader>
      <QueryState
        loading={data.isLoading}
        error={data.error}
        empty={data.data === undefined}
      >
        {
          <>
            <div className="metric-grid">
              <Metric
                label="Accepted events"
                value={number(totals.acceptedEvents)}
              />
              <Metric
                label="Original success rate"
                value={`${successRate.toFixed(1)}%`}
              />
              <Metric
                label="Retrying now"
                value={number(data.data?.retryingCount)}
                tone="warning"
              />
              <Metric
                label="Dead letters"
                value={number(totals.deadLetters)}
                tone="danger"
              />
              <Metric
                label="Replay successes"
                value={number(totals.replaySuccesses)}
              />
              <Metric
                label="Average latency"
                value={`${Math.round(data.data?.averageLatencyMs ?? 0)} ms`}
              />
            </div>
            <section className="panel">
              <h2>Destination health</h2>
              <QueryState
                loading={false}
                error={undefined}
                empty={(data.data?.destinations.length ?? 0) === 0}
              >
                <table>
                  <thead>
                    <tr>
                      <th>Destination</th>
                      <th>Enabled</th>
                      <th>Circuit</th>
                      <th>Failures</th>
                      <th>Successes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.data?.destinations.map((destination) => (
                      <tr key={destination.destinationId}>
                        <td>
                          {destination.name}
                          <small>{destination.destinationId}</small>
                        </td>
                        <td>
                          <Status
                            value={destination.enabled ? "enabled" : "disabled"}
                          />
                        </td>
                        <td>
                          <Status value={destination.circuit.state} />
                        </td>
                        <td>{number(destination.totals.deliveryFailures)}</td>
                        <td>{number(destination.totals.deliverySuccesses)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </QueryState>
            </section>
          </>
        }
      </QueryState>
    </>
  );
}
function Metric({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: string;
}) {
  return (
    <section
      className={`metric ${tone === undefined ? "" : `metric-${tone}`} `}
    >
      <span>{label}</span>
      <strong>{value}</strong>
    </section>
  );
}

function EventsPage() {
  const token = useToken();
  const [filters, setFilters] = useState({
    term: "",
    type: "",
    status: "",
    cursor: undefined as string | undefined,
  });
  const values = useMemo(
    () => ({
      ...dateRange(),
      eventType: filters.type,
      status: filters.status,
      correlationId: filters.term.startsWith("cor_") ? filters.term : undefined,
      eventId: filters.term.startsWith("evt_") ? filters.term : undefined,
      idempotencyKey:
        filters.term !== "" &&
        !filters.term.startsWith("cor_") &&
        !filters.term.startsWith("evt_")
          ? filters.term
          : undefined,
      cursor: filters.cursor,
    }),
    [filters],
  );
  const data = useQuery({
    queryKey: ["events", values],
    queryFn: () =>
      api<PaginatedResponse<EventRecord>>(
        token,
        `/api/v1/events${query(values)}`,
      ),
  });
  return (
    <>
      <PageHeader title="Events" />
      <FilterBar
        onSubmit={(event) => {
          event.preventDefault();
          setFilters((current) => ({ ...current, cursor: undefined }));
        }}
      >
        <label>
          Search
          <input
            aria-label="Search events"
            value={filters.term}
            onChange={(event) =>
              setFilters({ ...filters, term: event.target.value })
            }
            placeholder="Event, correlation, or idempotency key"
          />
        </label>
        <label>
          Type
          <input
            value={filters.type}
            onChange={(event) =>
              setFilters({ ...filters, type: event.target.value })
            }
          />
        </label>
        <label>
          Status
          <select
            value={filters.status}
            onChange={(event) =>
              setFilters({ ...filters, status: event.target.value })
            }
          >
            <option value="">All</option>
            <option>succeeded</option>
            <option>processing</option>
            <option>failed</option>
          </select>
        </label>
      </FilterBar>
      <QueryState
        loading={data.isLoading}
        error={data.error}
        empty={(data.data?.items.length ?? 0) === 0}
      >
        <table>
          <thead>
            <tr>
              <th>Event</th>
              <th>Type</th>
              <th>Status</th>
              <th>Accepted</th>
            </tr>
          </thead>
          <tbody>
            {data.data?.items.map((event) => (
              <tr key={event.eventId}>
                <td>
                  <Link to={`/events/${event.eventId}`}>{event.eventId}</Link>
                  <small>{event.correlationId}</small>
                </td>
                <td>{event.eventType}</td>
                <td>
                  <Status value={event.status} />
                </td>
                <td>{formatDate(event.acceptedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pagination
          cursor={data.data?.cursor}
          onNext={() => setFilters({ ...filters, cursor: data.data?.cursor })}
        />
      </QueryState>
    </>
  );
}
function EventDetailPage() {
  const token = useToken();
  const { eventId = "" } = useParams();
  const data = useQuery({
    queryKey: ["event", eventId],
    queryFn: () => api<EventDetail>(token, `/api/v1/events/${eventId}`),
  });
  return (
    <>
      <PageHeader title="Event detail" />
      <QueryState
        loading={data.isLoading}
        error={data.error}
        empty={data.data === undefined}
      >
        {data.data === undefined ? null : (
          <>
            <section className="panel details">
              <Status value={data.data.event.status} />
              <dl>
                <Detail label="Event ID" value={data.data.event.eventId} />
                <Detail
                  label="Correlation"
                  value={data.data.event.correlationId}
                />
                <Detail label="Type" value={data.data.event.eventType} />
                <Detail
                  label="Accepted"
                  value={formatDate(data.data.event.acceptedAt)}
                />
              </dl>
            </section>
            <section className="panel">
              <h2>Associated deliveries</h2>
              <DeliveryTable items={data.data.deliveries} />
            </section>
            {data.data.replayRelations.length === 0 ? null : (
              <section className="panel">
                <h2>Replay relationships</h2>
                <JsonView
                  label="Replay relationships"
                  value={data.data.replayRelations}
                />
              </section>
            )}
          </>
        )}
      </QueryState>
    </>
  );
}

function DeliveriesPage({
  deadLetters = false,
}: {
  readonly deadLetters?: boolean;
}) {
  const token = useToken();
  const [filters, setFilters] = useState({
    term: "",
    status: "",
    partnerId: "",
    destinationId: "",
    cursor: undefined as string | undefined,
  });
  const values = useMemo(
    () => ({
      ...dateRange(),
      deliveryId: filters.term.startsWith("dlv_") ? filters.term : undefined,
      correlationId: filters.term.startsWith("cor_") ? filters.term : undefined,
      partnerId: filters.partnerId,
      destinationId: filters.destinationId,
      status: deadLetters ? undefined : filters.status,
      terminalFailure: deadLetters ? "true" : undefined,
      cursor: filters.cursor,
    }),
    [deadLetters, filters],
  );
  const data = useQuery({
    queryKey: ["deliveries", values],
    queryFn: () =>
      api<PaginatedResponse<DeliveryRecord>>(
        token,
        `/api/v1/deliveries${query(values)}`,
      ),
    refetchInterval: 10_000,
  });
  return (
    <>
      <PageHeader
        title={deadLetters ? "Dead-letter investigation" : "Deliveries"}
      />
      <FilterBar
        onSubmit={(event) => {
          event.preventDefault();
          setFilters((current) => ({ ...current, cursor: undefined }));
        }}
      >
        <label>
          Search
          <input
            aria-label="Search deliveries"
            value={filters.term}
            onChange={(event) =>
              setFilters({ ...filters, term: event.target.value })
            }
            placeholder="Delivery or correlation ID"
          />
        </label>
        {deadLetters ? null : (
          <label>
            Status
            <select
              value={filters.status}
              onChange={(event) =>
                setFilters({ ...filters, status: event.target.value })
              }
            >
              <option value="">All</option>
              <option>scheduled</option>
              <option>retry_scheduled</option>
              <option>succeeded</option>
              <option>failed_terminal</option>
              <option>dead_lettered</option>
            </select>
          </label>
        )}
        <label>
          Partner ID
          <input
            value={filters.partnerId}
            onChange={(event) =>
              setFilters({ ...filters, partnerId: event.target.value })
            }
          />
        </label>
        <label>
          Destination ID
          <input
            value={filters.destinationId}
            onChange={(event) =>
              setFilters({ ...filters, destinationId: event.target.value })
            }
          />
        </label>
      </FilterBar>
      <QueryState
        loading={data.isLoading}
        error={data.error}
        empty={(data.data?.items.length ?? 0) === 0}
      >
        <DeliveryTable items={data.data?.items ?? []} />
        <Pagination
          cursor={data.data?.cursor}
          onNext={() => setFilters({ ...filters, cursor: data.data?.cursor })}
        />
      </QueryState>
    </>
  );
}
function DeliveryTable({
  items,
}: {
  readonly items: readonly DeliveryRecord[];
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>Delivery</th>
          <th>State</th>
          <th>Failure</th>
          <th>Attempts</th>
          <th>Updated</th>
        </tr>
      </thead>
      <tbody>
        {items.map((delivery) => (
          <tr key={delivery.deliveryId}>
            <td>
              <Link to={`/deliveries/${delivery.deliveryId}`}>
                {delivery.deliveryId}
              </Link>
              <small>{delivery.executionType.toLowerCase()}</small>
            </td>
            <td>
              <Status value={delivery.state} />
            </td>
            <td>{delivery.lastFailureCategory ?? "—"}</td>
            <td>
              {delivery.attemptCount}/{delivery.maxAttempts}
            </td>
            <td>{formatDate(delivery.updatedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
function DeliveryDetailPage() {
  const token = useToken();
  const { deliveryId = "" } = useParams();
  const { session } = useAuth();
  const client = useQueryClient();
  const [replayOpen, setReplayOpen] = useState(false);
  const data = useQuery({
    queryKey: ["delivery", deliveryId],
    queryFn: () =>
      api<DeliveryDetail>(token, `/api/v1/deliveries/${deliveryId}`),
    refetchInterval: (result) =>
      result.state.data?.delivery.state.includes("succeeded") ||
      result.state.data?.delivery.state.includes("dead")
        ? false
        : 10_000,
  });
  const replay = useMutation({
    mutationFn: ({
      reason,
      correctionConfirmed,
      idempotencyKey,
    }: {
      readonly reason: string;
      readonly correctionConfirmed: boolean;
      readonly idempotencyKey: string;
    }) =>
      api<JsonRecord>(token, `/api/v1/deliveries/${deliveryId}/replays`, {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
        body: JSON.stringify({ reason, correctionConfirmed }),
      }),
    onSuccess: () => {
      setReplayOpen(false);
      void client.invalidateQueries({ queryKey: ["delivery", deliveryId] });
      void client.invalidateQueries({ queryKey: ["deliveries"] });
    },
  });
  const detail = data.data;
  return (
    <>
      <PageHeader title="Delivery detail">
        {detail !== undefined &&
        canReplay(session?.role) &&
        detail.replayEligibility.allowed ? (
          <button
            className="button button-primary"
            onClick={() => setReplayOpen(true)}
          >
            Replay delivery
          </button>
        ) : null}
      </PageHeader>
      <QueryState
        loading={data.isLoading}
        error={data.error}
        empty={detail === undefined}
      >
        {detail === undefined ? null : (
          <>
            <section className="panel details">
              <Status value={detail.delivery.state} />
              <dl>
                <Detail
                  label="Delivery ID"
                  value={detail.delivery.deliveryId}
                />
                <Detail label="Event ID" value={detail.delivery.eventId} />
                <Detail
                  label="Destination"
                  value={detail.delivery.destinationId}
                />
                <Detail
                  label="Failure"
                  value={detail.delivery.lastFailureCategory ?? "—"}
                />
                <Detail
                  label="Execution"
                  value={detail.delivery.executionType}
                />
              </dl>
            </section>
            <section className="split">
              <section className="panel">
                <h2>Attempt timeline</h2>
                <Timeline attempts={detail.attempts} history={detail.history} />
              </section>
              <section className="panel">
                <h2>Redacted payload</h2>
                <JsonView
                  label="Redacted transformed payload"
                  value={detail.delivery.transformedPayload}
                />
              </section>
            </section>
            <section className="panel">
              <h2>Replay relationships</h2>
              <JsonView
                label="Replay relations"
                value={detail.replayRelations}
              />
            </section>
            {replayOpen ? (
              <ReplayDialog
                detail={detail}
                loading={replay.isPending}
                error={replay.error}
                onClose={() => setReplayOpen(false)}
                onSubmit={(reason, correctionConfirmed, idempotencyKey) =>
                  replay.mutate({ reason, correctionConfirmed, idempotencyKey })
                }
              />
            ) : null}
          </>
        )}
      </QueryState>
    </>
  );
}
function Timeline({
  attempts,
  history,
}: {
  readonly attempts: readonly AttemptRecord[];
  readonly history: readonly HistoryRecord[];
}) {
  const entries = [
    ...attempts.map((attempt) => ({
      at: attempt.startedAt,
      title: `Attempt ${attempt.attemptNumber}: ${attempt.outcome}`,
      note: attempt.failureCategory ?? `${attempt.durationMs ?? 0} ms`,
    })),
    ...history.map((item) => ({
      at: item.occurredAt,
      title: item.type.replaceAll("_", " "),
      note: item.summary,
    })),
  ].sort((left, right) => left.at.localeCompare(right.at));
  return (
    <ol className="timeline">
      {entries.map((entry, index) => (
        <li key={`${entry.at}-${index}`}>
          <time>{formatDate(entry.at)}</time>
          <strong>{entry.title}</strong>
          <span>{entry.note}</span>
        </li>
      ))}
    </ol>
  );
}
function ReplayDialog({
  detail,
  loading,
  error,
  onClose,
  onSubmit,
}: {
  readonly detail: DeliveryDetail;
  readonly loading: boolean;
  readonly error: unknown;
  onClose(): void;
  onSubmit(
    reason: string,
    correctionConfirmed: boolean,
    idempotencyKey: string,
  ): void;
}) {
  const [reason, setReason] = useState("");
  const [correctionConfirmed, setCorrectionConfirmed] = useState(false);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const valid =
    reason.trim().length >= 10 &&
    reason.trim().length <= 1000 &&
    (!detail.replayEligibility.requiresCorrection || correctionConfirmed);
  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="replay-title"
      >
        <h2 id="replay-title">Replay delivery</h2>
        <p>
          Original failure:{" "}
          <strong>
            {detail.delivery.lastFailureCategory ?? detail.delivery.state}
          </strong>
          . This creates a new execution and preserves the original record.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (valid)
              onSubmit(reason.trim(), correctionConfirmed, idempotencyKey);
          }}
        >
          <label>
            Reason
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              minLength={10}
              maxLength={1000}
              required
            />
          </label>
          {detail.replayEligibility.requiresCorrection ? (
            <label className="check">
              <input
                type="checkbox"
                checked={correctionConfirmed}
                onChange={(event) =>
                  setCorrectionConfirmed(event.target.checked)
                }
              />{" "}
              I confirm the terminal condition was corrected.
            </label>
          ) : null}
          <ErrorNotice error={error} />
          <div className="dialog-actions">
            <button type="button" className="button" onClick={onClose}>
              Cancel
            </button>
            <button
              className="button button-primary"
              disabled={!valid || loading}
            >
              {loading ? "Requesting…" : "Confirm replay"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function PartnersPage() {
  const token = useToken();
  const { session } = useAuth();
  const client = useQueryClient();
  const admin = canMutate(session?.role);
  const partners = useQuery({
    queryKey: ["partners"],
    queryFn: () =>
      api<PaginatedResponse<PartnerRecord>>(
        token,
        "/api/v1/partners?limit=100",
      ),
  });
  const destinations = useQuery({
    queryKey: ["destinations"],
    queryFn: () =>
      api<PaginatedResponse<DestinationRecord>>(
        token,
        "/api/v1/destinations?limit=100",
      ),
  });
  const transformations = useQuery({
    queryKey: ["transformations"],
    queryFn: () =>
      api<PaginatedResponse<TransformationSummaryResponse>>(
        token,
        "/api/v1/transformations?limit=100",
      ),
  });
  const subscriptions = useQuery({
    queryKey: ["subscriptions"],
    queryFn: () =>
      api<PaginatedResponse<JsonRecord>>(
        token,
        "/api/v1/subscriptions?limit=100",
      ),
  });
  const invalidate = () => {
    void client.invalidateQueries({ queryKey: ["partners"] });
    void client.invalidateQueries({ queryKey: ["destinations"] });
    void client.invalidateQueries({ queryKey: ["transformations"] });
    void client.invalidateQueries({ queryKey: ["subscriptions"] });
  };
  return (
    <>
      <PageHeader title="Partner configuration" />
      <QueryState
        loading={partners.isLoading || destinations.isLoading}
        error={partners.error ?? destinations.error}
        empty={false}
      >
        <section className="split">
          <section className="panel">
            <h2>Partners and destinations</h2>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Enabled</th>
                  <th>Destinations</th>
                </tr>
              </thead>
              <tbody>
                {partners.data?.items.map((partner) => (
                  <tr key={partner.partnerId}>
                    <td>
                      {partner.name}
                      <small>{partner.partnerId}</small>
                    </td>
                    <td>
                      <Status
                        value={partner.enabled ? "enabled" : "disabled"}
                      />
                    </td>
                    <td>
                      {destinations.data?.items
                        .filter((item) => item.partnerId === partner.partnerId)
                        .map((item) => (
                          <span
                            className="inline-status"
                            key={item.destinationId}
                          >
                            {item.name}{" "}
                            <Status value={item.circuit?.state ?? "CLOSED"} />
                          </span>
                        ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {admin ? <PartnerCreate token={token} done={invalidate} /> : null}
            {admin ? (
              <DestinationCreate
                token={token}
                partners={partners.data?.items ?? []}
                transformations={transformations.data?.items ?? []}
                done={invalidate}
              />
            ) : null}
          </section>
          <section className="panel">
            <h2>Destination policy</h2>
            {destinations.data?.items.map((destination) => (
              <DestinationEditor
                key={destination.destinationId}
                token={token}
                destination={destination}
                enabled={admin}
                done={invalidate}
              />
            ))}
          </section>
        </section>
        <section className="split">
          <section className="panel">
            <h2>Transformations</h2>
            <ul className="plain-list">
              {transformations.data?.items.map((item) => (
                <li key={item.transformationId}>
                  {item.externalKey}{" "}
                  <small>
                    v{item.latestVersion} · {item.transformationId}
                  </small>
                </li>
              ))}
            </ul>
            {admin ? <TransformationValidator token={token} /> : null}
          </section>
          <section className="panel">
            <h2>Subscriptions</h2>
            <ul className="plain-list">
              {subscriptions.data?.items.map((item) => (
                <li key={String(item.subscriptionId)}>
                  {String(item.eventType)}{" "}
                  <small>{String(item.destinationId)}</small>
                  {admin ? (
                    <button
                      className="link-button"
                      onClick={() =>
                        void api<void>(
                          token,
                          `/api/v1/subscriptions/${String(item.subscriptionId)}`,
                          { method: "DELETE" },
                        ).then(invalidate)
                      }
                    >
                      Remove
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
            {admin ? (
              <SubscriptionCreate
                token={token}
                destinations={destinations.data?.items ?? []}
                done={invalidate}
              />
            ) : null}
          </section>
        </section>
      </QueryState>
    </>
  );
}
function PartnerCreate({
  token,
  done,
}: {
  readonly token: string;
  done(): void;
}) {
  const [name, setName] = useState("");
  const [externalKey, setExternalKey] = useState("");
  const mutation = useMutation({
    mutationFn: () =>
      api<JsonRecord>(token, "/api/v1/partners", {
        method: "POST",
        body: JSON.stringify({ name, externalKey, enabled: true }),
      }),
    onSuccess: () => {
      setName("");
      setExternalKey("");
      done();
    },
  });
  return (
    <form
      className="compact-form"
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate();
      }}
    >
      <h3>Create partner</h3>
      <label>
        Name
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />
      </label>
      <label>
        External key
        <input
          value={externalKey}
          onChange={(event) => setExternalKey(event.target.value)}
          required
          pattern="[a-z][a-z0-9_-]*"
        />
      </label>
      <ErrorNotice error={mutation.error} />
      <button className="button button-primary" disabled={mutation.isPending}>
        Create partner
      </button>
    </form>
  );
}
function DestinationCreate({
  token,
  partners,
  transformations,
  done,
}: {
  readonly token: string;
  readonly partners: readonly PartnerRecord[];
  readonly transformations: readonly TransformationSummaryResponse[];
  done(): void;
}) {
  const [partnerId, setPartnerId] = useState("");
  const [name, setName] = useState("");
  const [externalKey, setExternalKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("http://mock-partner-alpha:4011");
  const [path, setPath] = useState("/deliveries");
  const [transformationId, setTransformationId] = useState("");
  const [secretAlias, setSecretAlias] = useState("partner-api-key");
  const [secret, setSecret] = useState("");
  const mutation = useMutation({
    mutationFn: () =>
      api<JsonRecord>(token, `/api/v1/partners/${partnerId}/destinations`, {
        method: "POST",
        body: JSON.stringify({
          name,
          externalKey,
          baseUrl,
          path,
          enabled: true,
          timeoutMs: 5000,
          retryPolicy: {
            maxAttempts: 5,
            initialDelaySeconds: 1,
            maxDelaySeconds: 60,
            multiplier: 2,
            jitter: "FULL_UPPER_HALF",
          },
          rateLimitPolicy: {
            requestsPerInterval: 10,
            intervalSeconds: 1,
            burstCapacity: 20,
            safetyFactor: 1,
          },
          circuitBreakerPolicy: {
            failureThreshold: 5,
            cooldownSeconds: 30,
            probeLeaseSeconds: 5,
          },
          transformationId,
          activeTransformationVersion: 1,
          sensitiveResponseJsonPaths: [],
          authentication: {
            type: "api_key",
            headerName: "X-API-Key",
            idempotencyHeader: "Idempotency-Key",
            credential: { alias: secretAlias, value: secret },
          },
        }),
      }),
    onSuccess: done,
  });
  return (
    <form
      className="compact-form"
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate();
      }}
    >
      <h3>Create destination</h3>
      <label>
        Partner
        <select
          value={partnerId}
          onChange={(event) => setPartnerId(event.target.value)}
          required
        >
          <option value="">Select partner</option>
          {partners.map((partner) => (
            <option key={partner.partnerId} value={partner.partnerId}>
              {partner.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Name
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />
      </label>
      <label>
        External key
        <input
          value={externalKey}
          onChange={(event) => setExternalKey(event.target.value)}
          required
          pattern="[a-z][a-z0-9_-]*"
        />
      </label>
      <label>
        Base URL
        <input
          type="url"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          required
        />
      </label>
      <label>
        Path
        <input
          value={path}
          onChange={(event) => setPath(event.target.value)}
          required
          pattern="/[A-Za-z0-9_./-]*"
        />
      </label>
      <label>
        Transformation
        <select
          value={transformationId}
          onChange={(event) => setTransformationId(event.target.value)}
          required
        >
          <option value="">Select transformation</option>
          {transformations.map((item) => (
            <option key={item.transformationId} value={item.transformationId}>
              {item.externalKey} v{item.latestVersion}
            </option>
          ))}
        </select>
      </label>
      <label>
        Secret alias
        <input
          value={secretAlias}
          onChange={(event) => setSecretAlias(event.target.value)}
          required
        />
      </label>
      <label>
        API key
        <input
          type="password"
          autoComplete="new-password"
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          required
        />
      </label>
      <ErrorNotice error={mutation.error} />
      <button className="button button-primary" disabled={mutation.isPending}>
        Create destination
      </button>
    </form>
  );
}
function DestinationEditor({
  token,
  destination,
  enabled,
  done,
}: {
  readonly token: string;
  readonly destination: DestinationRecord;
  readonly enabled: boolean;
  done(): void;
}) {
  const [active, setActive] = useState(false);
  const [timeoutMs, setTimeoutMs] = useState(
    String(destination.timeoutMs ?? ""),
  );
  const [isEnabled, setIsEnabled] = useState(destination.enabled);
  const [replacement, setReplacement] = useState("");
  const [alias, setAlias] = useState(
    destination.credential?.alias ?? "partner-api-key",
  );
  const mutation = useMutation({
    mutationFn: () => {
      const authentication =
        replacement === ""
          ? undefined
          : {
              type: "api_key",
              headerName:
                typeof destination.authConfiguration?.headerName === "string"
                  ? destination.authConfiguration.headerName
                  : "X-API-Key",
              idempotencyHeader:
                typeof destination.authConfiguration?.idempotencyHeader ===
                "string"
                  ? destination.authConfiguration.idempotencyHeader
                  : "Idempotency-Key",
              credential: { alias, value: replacement },
            };
      return api<JsonRecord>(
        token,
        `/api/v1/destinations/${destination.destinationId}`,
        {
          method: "PATCH",
          headers: { "if-match": `"${destination.version}"` },
          body: JSON.stringify({
            enabled: isEnabled,
            timeoutMs: Number(timeoutMs),
            ...(authentication === undefined ? {} : { authentication }),
          }),
        },
      );
    },
    onSuccess: () => {
      setActive(false);
      setReplacement("");
      done();
    },
  });
  return (
    <article className="destination">
      <div>
        <strong>{destination.name}</strong>
        <small>
          {destination.authType} · {destination.destinationId}
        </small>
      </div>
      <Status value={destination.circuit?.state ?? "CLOSED"} />
      {enabled ? (
        <button
          className="button button-quiet"
          onClick={() => setActive(!active)}
        >
          {active ? "Close" : "Edit"}
        </button>
      ) : null}
      {active ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <label>
            Timeout ms
            <input
              type="number"
              min="100"
              max="30000"
              value={timeoutMs}
              onChange={(event) => setTimeoutMs(event.target.value)}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={isEnabled}
              onChange={(event) => setIsEnabled(event.target.checked)}
            />{" "}
            Enabled
          </label>
          {destination.authType === "api_key" ? (
            <>
              <label>
                Replacement secret alias
                <input
                  value={alias}
                  onChange={(event) => setAlias(event.target.value)}
                />
              </label>
              <label>
                Replace API key{" "}
                <small>(leave blank to retain current secret)</small>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={replacement}
                  onChange={(event) => setReplacement(event.target.value)}
                />
              </label>
            </>
          ) : (
            <p className="muted">
              This OAuth destination’s secret is configured but redacted. Use
              its API configuration workflow to rotate it.
            </p>
          )}
          <ErrorNotice error={mutation.error} />
          <button
            className="button button-primary"
            disabled={mutation.isPending}
          >
            Save destination
          </button>
        </form>
      ) : null}
    </article>
  );
}
function TransformationValidator({ token }: { readonly token: string }) {
  const [definition, setDefinition] = useState(
    '{"schemaVersion":1,"contentType":"application/json","mappings":[{"target":"$.eventType","source":"$.eventType"}]}',
  );
  const [sampleEvent, setSampleEvent] = useState("{}");
  const mutation = useMutation({
    mutationFn: () =>
      api<JsonRecord>(token, "/api/v1/transformations/validate", {
        method: "POST",
        body: JSON.stringify({
          definition: JSON.parse(definition),
          sampleEvent: JSON.parse(sampleEvent),
        }),
      }),
  });
  return (
    <form
      className="compact-form"
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate();
      }}
    >
      <h3>Validate transformation</h3>
      <label>
        Definition
        <textarea
          value={definition}
          onChange={(event) => setDefinition(event.target.value)}
        />
      </label>
      <label>
        Sample canonical event
        <textarea
          value={sampleEvent}
          onChange={(event) => setSampleEvent(event.target.value)}
        />
      </label>
      <ErrorNotice error={mutation.error} />
      <button className="button">Validate</button>
      {mutation.data === undefined ? null : (
        <JsonView
          label="Transformation validation result"
          value={mutation.data}
        />
      )}
    </form>
  );
}
function SubscriptionCreate({
  token,
  destinations,
  done,
}: {
  readonly token: string;
  readonly destinations: readonly DestinationRecord[];
  done(): void;
}) {
  const [destinationId, setDestinationId] = useState("");
  const [eventType, setEventType] = useState("shipment.status_changed");
  const [externalKey, setExternalKey] = useState("subscription");
  const mutation = useMutation({
    mutationFn: () =>
      api<JsonRecord>(token, "/api/v1/subscriptions", {
        method: "POST",
        body: JSON.stringify({
          destinationId,
          eventType,
          externalKey,
          enabled: true,
        }),
      }),
    onSuccess: done,
  });
  return (
    <form
      className="compact-form"
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate();
      }}
    >
      <h3>Add subscription</h3>
      <label>
        Destination
        <select
          value={destinationId}
          onChange={(event) => setDestinationId(event.target.value)}
          required
        >
          <option value="">Select destination</option>
          {destinations.map((destination) => (
            <option
              key={destination.destinationId}
              value={destination.destinationId}
            >
              {destination.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Event type
        <input
          value={eventType}
          onChange={(event) => setEventType(event.target.value)}
          required
        />
      </label>
      <label>
        External key
        <input
          value={externalKey}
          onChange={(event) => setExternalKey(event.target.value)}
          required
        />
      </label>
      <ErrorNotice error={mutation.error} />
      <button className="button button-primary">Add subscription</button>
    </form>
  );
}

function AuditPage() {
  const token = useToken();
  const [filters, setFilters] = useState({
    action: "",
    actorId: "",
    cursor: undefined as string | undefined,
  });
  const values = useMemo(
    () => ({
      ...dateRange(),
      action: filters.action,
      actorId: filters.actorId,
      cursor: filters.cursor,
    }),
    [filters],
  );
  const data = useQuery({
    queryKey: ["audit", values],
    queryFn: () =>
      api<PaginatedResponse<AuditRecord>>(
        token,
        `/api/v1/audit-logs${query(values)}`,
      ),
  });
  return (
    <>
      <PageHeader title="Audit activity" />
      <FilterBar
        onSubmit={(event) => {
          event.preventDefault();
          setFilters((current) => ({ ...current, cursor: undefined }));
        }}
      >
        <label>
          Action
          <input
            value={filters.action}
            onChange={(event) =>
              setFilters({ ...filters, action: event.target.value })
            }
          />
        </label>
        <label>
          Actor
          <input
            value={filters.actorId}
            onChange={(event) =>
              setFilters({ ...filters, actorId: event.target.value })
            }
          />
        </label>
      </FilterBar>
      <QueryState
        loading={data.isLoading}
        error={data.error}
        empty={(data.data?.items.length ?? 0) === 0}
      >
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Target</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {data.data?.items.map((item) => (
              <tr key={item.auditId}>
                <td>{formatDate(item.occurredAt)}</td>
                <td>{item.actorId}</td>
                <td>{item.action}</td>
                <td>
                  {item.targetType}: {item.targetId}
                </td>
                <td>{item.reason ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pagination
          cursor={data.data?.cursor}
          onNext={() => setFilters({ ...filters, cursor: data.data?.cursor })}
        />
      </QueryState>
    </>
  );
}

function FilterBar({
  children,
  onSubmit,
}: {
  readonly children: ReactNode;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
}) {
  return (
    <form className="filters" onSubmit={onSubmit}>
      {children}
      <button className="button" type="submit">
        Apply
      </button>
    </form>
  );
}
function Pagination({
  cursor,
  onNext,
}: {
  readonly cursor?: string | undefined;
  onNext(): void;
}) {
  return cursor === undefined ? null : (
    <div className="pagination">
      <button className="button" onClick={onNext}>
        Next page
      </button>
    </div>
  );
}
function Detail({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Console() {
  return (
    <Shell>
      <Routes>
        <Route path="/overview" element={<OverviewPage />} />
        <Route path="/events" element={<EventsPage />} />
        <Route path="/events/:eventId" element={<EventDetailPage />} />
        <Route path="/deliveries" element={<DeliveriesPage />} />
        <Route
          path="/deliveries/:deliveryId"
          element={<DeliveryDetailPage />}
        />
        <Route path="/dead-letters" element={<DeliveriesPage deadLetters />} />
        <Route path="/partners" element={<PartnersPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="*" element={<Navigate to="/overview" replace />} />
      </Routes>
    </Shell>
  );
}
export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route
          path="/*"
          element={
            <Protected>
              <Console />
            </Protected>
          }
        />
      </Routes>
    </AuthProvider>
  );
}
