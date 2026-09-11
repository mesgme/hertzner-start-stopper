/**
 * @mesgme/hertzner — start and stop a named Hetzner Cloud server.
 *
 * A general-purpose, reusable extension: bind one model instance to one server
 * by name, then `start` or `stop` it without opening the Hetzner web console.
 *
 * API:      https://api.hetzner.cloud/v1
 * Lookup:   GET  /servers?name={name}          (name → id, current status)
 * Start:    POST /servers/{id}/actions/poweron
 * Stop:     POST /servers/{id}/actions/poweroff
 * Auth:     Authorization: Bearer <token>
 *
 * The token is never hardcoded. Store it in the vault once:
 *
 *   swamp vault set hetzner-api-token '<paste-token>'
 *
 * and wire it into the model definition:
 *
 *   swamp model create @mesgme/hertzner hertzner-start-stopper \
 *     --global-arg serverName=<your-server-name> \
 *     --global-arg 'token=${{ vault.get("hetzner-api-token") }}'
 *
 * Then run:
 *
 *   swamp model @mesgme/hertzner method run start hertzner-start-stopper
 *   swamp model @mesgme/hertzner method run stop  hertzner-start-stopper
 *
 * Each run writes a `serverStatus` resource, so the last observed power state
 * is queryable:
 *
 *   swamp data query 'modelType == "@mesgme/hertzner" &&
 *     specName == "serverStatus" && isLatest'
 *
 * The API token must have read & write permission (a read-only token cannot
 * perform power actions).
 *
 * @module
 */
import { z } from "npm:zod@4";

/** Base URL for the Hetzner Cloud API (v1). */
export const HETZNER_API_BASE = "https://api.hetzner.cloud/v1";

/** The two operations this model exposes. */
export type PowerAction = "start" | "stop";

/** Hetzner action command for each operation. */
const ACTION_COMMAND: Record<PowerAction, string> = {
  start: "poweron",
  stop: "poweroff",
};

/** Server status the action is trying to reach. */
const TARGET_STATUS: Record<PowerAction, string> = {
  start: "running",
  stop: "off",
};

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  /** Name of the Hetzner Cloud server this model instance controls. */
  serverName: z
    .string()
    .min(1)
    .describe("Name of the Hetzner Cloud server this model controls."),
  /**
   * Hetzner Cloud API token with read & write permission.
   * Wire it from the vault — never pass a literal:
   * token=${{ vault.get("hetzner-api-token") }}
   */
  token: z
    .string()
    .min(1)
    .meta({ sensitive: true })
    .describe(
      "Hetzner Cloud API token (read & write). Use a vault.get() expression.",
    ),
  /** API base URL. Overridable for tests or an API proxy. */
  baseUrl: z.string().default(HETZNER_API_BASE),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** A Hetzner Cloud server object (only the fields we use). */
const ServerSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  status: z.string(),
  public_net: z
    .object({
      ipv4: z.object({ ip: z.string().nullable().optional() }).nullish(),
      ipv6: z.object({ ip: z.string().nullable().optional() }).nullish(),
    })
    .nullish(),
});

export type HetznerServer = z.infer<typeof ServerSchema>;

const ServerListSchema = z.object({ servers: z.array(ServerSchema) });

const ServerStatusSchema = z.object({
  /** Name the caller asked for. */
  serverName: z.string(),
  /** Resolved Hetzner numeric server id. */
  serverId: z.number().int(),
  /** Which operation was performed. */
  action: z.enum(["start", "stop"]),
  /** Power status observed before the action ran. */
  previousStatus: z.string(),
  /** Power status after the action completed (running / off). */
  status: z.string(),
  /** Public IPv4 address, when the server has one. */
  ipv4: z.string().optional(),
  /** Public IPv6 address, when the server has one. */
  ipv6: z.string().optional(),
  /** Hetzner action id returned by the power action. */
  actionId: z.number().int().optional(),
  /** When the observation was recorded. */
  fetchedAt: z.iso.datetime(),
});

type ServerStatusData = z.infer<typeof ServerStatusSchema>;

const PowerArgsSchema = z.object({
  /** How many times to re-read the server while waiting for the target status. */
  maxPollAttempts: z.number().int().min(1).max(120).default(10),
  /** Milliseconds to wait between status polls. */
  pollIntervalMs: z.number().int().min(0).max(60_000).default(1500),
});

type PowerArgs = z.infer<typeof PowerArgsSchema>;

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit testing
// ---------------------------------------------------------------------------

/** Remove trailing slashes from an API base URL. */
function stripTrailingSlashes(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** URL to resolve a server name to its id and current status. */
export function buildServerLookupUrl(baseUrl: string, name: string): string {
  return `${stripTrailingSlashes(baseUrl)}/servers?name=${
    encodeURIComponent(name)
  }`;
}

/** URL for the power action that implements `action`. */
export function buildActionUrl(
  baseUrl: string,
  serverId: number,
  action: PowerAction,
): string {
  return `${stripTrailingSlashes(baseUrl)}/servers/${serverId}/actions/${
    ACTION_COMMAND[action]
  }`;
}

/**
 * Pick the named server out of a `GET /servers?name=` response.
 *
 * Throws a clear not-found error when no server exactly matches `name` — the
 * API filter is a name match but the list can be empty or, defensively, hold
 * other servers.
 */
export function resolveServer(payload: unknown, name: string): HetznerServer {
  const { servers } = ServerListSchema.parse(payload);
  const found = servers.find((s) => s.name === name);
  if (!found) {
    throw new Error(
      `No Hetzner Cloud server named "${name}" was found. ` +
        `Check the spelling and that the API token belongs to the project that owns the server.`,
    );
  }
  return found;
}

/**
 * Refuse a no-op power action with a clear message. The caller already knows
 * the current status from the lookup, so an "already running" / "already off"
 * request is a mistake, not an API round-trip.
 */
export function assertNotAlreadyInState(
  currentStatus: string,
  action: PowerAction,
  serverName: string,
): void {
  if (action === "start" && currentStatus === "running") {
    throw new Error(
      `Server "${serverName}" is already running — nothing to do.`,
    );
  }
  if (action === "stop" && currentStatus === "off") {
    throw new Error(
      `Server "${serverName}" is already powered off — nothing to do.`,
    );
  }
}

/**
 * Turn a non-2xx Hetzner response into a clear, actionable error.
 * Exported so the message mapping can be tested without network I/O.
 */
export function apiError(
  operation: string,
  status: number,
  payload: unknown,
): Error {
  const err =
    (payload as { error?: { code?: string; message?: string } } | null)
      ?.error;
  const code = err?.code;
  const message = err?.message;

  if (status === 401 || code === "unauthorized") {
    const vaultExample = '${{ vault.get("hetzner-api-token") }}';
    return new Error(
      `Hetzner API authentication failed (HTTP ${status}) while ${operation}. ` +
        `Store a read & write token with: swamp vault set hetzner-api-token <token>, ` +
        `then recreate the model with --global-arg 'token=${vaultExample}'.`,
    );
  }
  if (status === 403 || code === "forbidden" || code === "token_readonly") {
    return new Error(
      `Hetzner API authorisation failed (HTTP ${status}) while ${operation}` +
        `${code ? ` [${code}]` : ""}. ` +
        `The API token may be read-only; start/stop requires read & write.`,
    );
  }
  return new Error(
    `Hetzner API request failed (HTTP ${status}) while ${operation}` +
      `${code ? ` [${code}]` : ""}${message ? `: ${message}` : ""}.`,
  );
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

type MethodContext = {
  globalArgs: GlobalArgs;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

function parseServer(raw: unknown): HetznerServer {
  return z.object({ server: ServerSchema }).parse(raw).server;
}

function extractActionId(raw: unknown): number | undefined {
  const parsed = z
    .object({ action: z.object({ id: z.number().int() }).partial() })
    .safeParse(raw);
  return parsed.success ? parsed.data.action.id : undefined;
}

async function pollForStatus(
  baseUrl: string,
  serverId: number,
  target: string,
  args: PowerArgs,
  headers: Record<string, string>,
): Promise<string> {
  const url = `${stripTrailingSlashes(baseUrl)}/servers/${serverId}`;
  let status = target;
  for (let attempt = 0; attempt < args.maxPollAttempts; attempt++) {
    if (attempt > 0 && args.pollIntervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, args.pollIntervalMs));
    }
    const res = await globalThis.fetch(url, { headers });
    const raw = await readJson(res);
    if (!res.ok) {
      throw apiError("reading the server status", res.status, raw);
    }
    status = parseServer(raw).status;
    if (status === target) break;
  }
  return status;
}

async function runPowerAction(
  action: PowerAction,
  args: PowerArgs,
  ctx: MethodContext,
): Promise<ServerStatusData> {
  const { serverName, token, baseUrl } = ctx.globalArgs;
  const headers = { Authorization: `Bearer ${token}` };

  const lookupRes = await globalThis.fetch(
    buildServerLookupUrl(baseUrl, serverName),
    { headers },
  );
  const lookupRaw = await readJson(lookupRes);
  if (!lookupRes.ok) {
    throw apiError("looking up the server", lookupRes.status, lookupRaw);
  }
  const server = resolveServer(lookupRaw, serverName);
  assertNotAlreadyInState(server.status, action, serverName);

  const actionRes = await globalThis.fetch(
    buildActionUrl(baseUrl, server.id, action),
    { method: "POST", headers },
  );
  const actionRaw = await readJson(actionRes);
  if (!actionRes.ok) {
    throw apiError(ACTION_COMMAND[action], actionRes.status, actionRaw);
  }
  const actionId = extractActionId(actionRaw);

  const status = await pollForStatus(
    baseUrl,
    server.id,
    TARGET_STATUS[action],
    args,
    headers,
  );

  return {
    serverName,
    serverId: server.id,
    action,
    previousStatus: server.status,
    status,
    ...(server.public_net?.ipv4?.ip ? { ipv4: server.public_net.ipv4.ip } : {}),
    ...(server.public_net?.ipv6?.ip ? { ipv6: server.public_net.ipv6.ip } : {}),
    ...(actionId !== undefined ? { actionId } : {}),
    fetchedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Model export
// ---------------------------------------------------------------------------

export const model = {
  type: "@mesgme/hertzner",
  version: "2026.09.11.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    serverStatus: {
      description:
        "Last observed power state of the bound Hetzner Cloud server, written by start/stop.",
      schema: ServerStatusSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },

  methods: {
    /**
     * Start the named server via POST /servers/{id}/actions/poweron.
     * Fails clearly if the server is not found, the token is rejected, or the
     * server is already running.
     */
    start: {
      description:
        "Start the named Hetzner Cloud server (POST poweron), then report its resulting status.",
      arguments: PowerArgsSchema,
      execute: async (args: PowerArgs, ctx: MethodContext) => {
        const status = await runPowerAction("start", args, ctx);
        ctx.logger.info(
          "started Hetzner server {serverName} (id {serverId}): {status}",
          {
            serverName: status.serverName,
            serverId: status.serverId,
            status: status.status,
          },
        );
        const handle = await ctx.writeResource(
          "serverStatus",
          "serverStatus",
          status,
        );
        return { dataHandles: [handle] };
      },
    },

    /**
     * Stop the named server via POST /servers/{id}/actions/poweroff.
     * Fails clearly if the server is not found, the token is rejected, or the
     * server is already powered off.
     */
    stop: {
      description:
        "Stop the named Hetzner Cloud server (POST poweroff), then report its resulting status.",
      arguments: PowerArgsSchema,
      execute: async (args: PowerArgs, ctx: MethodContext) => {
        const status = await runPowerAction("stop", args, ctx);
        ctx.logger.info(
          "stopped Hetzner server {serverName} (id {serverId}): {status}",
          {
            serverName: status.serverName,
            serverId: status.serverId,
            status: status.status,
          },
        );
        const handle = await ctx.writeResource(
          "serverStatus",
          "serverStatus",
          status,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
