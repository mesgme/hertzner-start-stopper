/**
 * Tests for the @mesgme/hertzner model type.
 *
 * Covers the pure URL/state helpers and the full start/stop execute paths with
 * the Hetzner Cloud API mocked via withMockedFetch. No real network calls.
 *
 * Run with: $(swamp doctor extensions --json | jq -r '.denoPath') test extensions/models/hertzner_test.ts
 *
 * @module
 */
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { withMockedFetch } from "jsr:@swamp-club/swamp-testing";
import {
  assertNotAlreadyInState,
  buildActionUrl,
  buildServerLookupUrl,
  HETZNER_API_BASE,
  model,
  resolveServer,
} from "./hertzner.ts";

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

/** A minimal Hetzner server object as returned by GET /servers. */
function server(
  id: number,
  name: string,
  status: string,
  ip = "203.0.113.10",
): Record<string, unknown> {
  return {
    id,
    name,
    status,
    public_net: {
      ipv4: { ip },
      ipv6: { ip: "2001:db8::1" },
    },
  };
}

/** Build a fake method context that records every writeResource call. */
function makeContext(
  globalArgs: Record<string, unknown>,
  writes: Array<
    { specName: string; name: string; data: Record<string, unknown> }
  > = [],
) {
  return {
    globalArgs: { baseUrl: HETZNER_API_BASE, ...globalArgs },
    logger: { info: () => {} },
    writeResource(
      specName: string,
      name: string,
      data: Record<string, unknown>,
    ): Promise<{ name: string }> {
      writes.push({ specName, name, data });
      return Promise.resolve({ name });
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test("HETZNER_API_BASE is the v1 Hetzner Cloud API", () => {
  assertEquals(HETZNER_API_BASE, "https://api.hetzner.cloud/v1");
});

Deno.test("buildServerLookupUrl resolves a name via the query string", () => {
  assertEquals(
    buildServerLookupUrl("https://api.hetzner.cloud/v1", "web-1"),
    "https://api.hetzner.cloud/v1/servers?name=web-1",
  );
});

Deno.test("buildServerLookupUrl URL-encodes the server name", () => {
  assertEquals(
    buildServerLookupUrl("https://api.hetzner.cloud/v1", "web 1/blue"),
    "https://api.hetzner.cloud/v1/servers?name=web%201%2Fblue",
  );
});

Deno.test("buildServerLookupUrl strips trailing slashes from the base", () => {
  assertEquals(
    buildServerLookupUrl("https://api.hetzner.cloud/v1/", "web-1"),
    "https://api.hetzner.cloud/v1/servers?name=web-1",
  );
});

Deno.test("buildActionUrl: start maps to POST poweron", () => {
  assertEquals(
    buildActionUrl("https://api.hetzner.cloud/v1", 42, "start"),
    "https://api.hetzner.cloud/v1/servers/42/actions/poweron",
  );
});

Deno.test("buildActionUrl: stop maps to POST poweroff", () => {
  assertEquals(
    buildActionUrl("https://api.hetzner.cloud/v1", 42, "stop"),
    "https://api.hetzner.cloud/v1/servers/42/actions/poweroff",
  );
});

Deno.test("buildActionUrl strips trailing slashes from the base", () => {
  assertEquals(
    buildActionUrl("https://api.hetzner.cloud/v1/", 7, "start"),
    "https://api.hetzner.cloud/v1/servers/7/actions/poweron",
  );
});

Deno.test("resolveServer returns the first match from a lookup response", () => {
  const found = resolveServer(
    { servers: [server(42, "web-1", "off")] },
    "web-1",
  );
  assertEquals(found.id, 42);
  assertEquals(found.name, "web-1");
  assertEquals(found.status, "off");
});

Deno.test("resolveServer throws a clear not-found error on an empty list", () => {
  let message = "";
  try {
    resolveServer({ servers: [] }, "missing");
  } catch (e) {
    message = (e as Error).message;
  }
  assertStringIncludes(message, 'No Hetzner Cloud server named "missing"');
});

Deno.test("resolveServer matches the exact name, not a prefix", () => {
  let message = "";
  try {
    resolveServer(
      { servers: [server(1, "web-10", "off"), server(2, "web-100", "off")] },
      "web-1",
    );
  } catch (e) {
    message = (e as Error).message;
  }
  assertStringIncludes(message, 'No Hetzner Cloud server named "web-1"');
});

Deno.test("assertNotAlreadyInState: start + running throws 'already running'", () => {
  let message = "";
  try {
    assertNotAlreadyInState("running", "start", "web-1");
  } catch (e) {
    message = (e as Error).message;
  }
  assertStringIncludes(message, "already running");
  assertStringIncludes(message, "web-1");
});

Deno.test("assertNotAlreadyInState: stop + off throws 'already powered off'", () => {
  let message = "";
  try {
    assertNotAlreadyInState("off", "stop", "web-1");
  } catch (e) {
    message = (e as Error).message;
  }
  assertStringIncludes(message, "already powered off");
});

Deno.test("assertNotAlreadyInState: start + off is allowed", () => {
  assertNotAlreadyInState("off", "start", "web-1");
});

Deno.test("assertNotAlreadyInState: stop + running is allowed", () => {
  assertNotAlreadyInState("running", "stop", "web-1");
});

// ---------------------------------------------------------------------------
// Model shape
// ---------------------------------------------------------------------------

Deno.test("model type is @mesgme/hertzner", () => {
  assertEquals(model.type, "@mesgme/hertzner");
});

Deno.test("model declares a serverStatus resource", () => {
  assertEquals("serverStatus" in model.resources, true);
});

Deno.test("model exposes start and stop methods", () => {
  assertEquals("start" in model.methods, true);
  assertEquals("stop" in model.methods, true);
});

// ---------------------------------------------------------------------------
// execute — start
// ---------------------------------------------------------------------------

Deno.test("start: powers on the server and writes running status", async () => {
  const writes: Array<
    { specName: string; name: string; data: Record<string, unknown> }
  > = [];
  const ctx = makeContext({ serverName: "web-1", token: "tok" }, writes);

  const { calls } = await withMockedFetch(async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/v1/servers") {
      return Response.json({ servers: [server(42, "web-1", "off")] });
    }
    if (url.pathname === "/v1/servers/42/actions/poweron") {
      return Response.json(
        { action: { id: 7, status: "running", command: "poweron" } },
        { status: 201 },
      );
    }
    if (url.pathname === "/v1/servers/42") {
      return Response.json({ server: server(42, "web-1", "running") });
    }
    return new Response("unexpected", { status: 500 });
  }, () =>
    // deno-lint-ignore no-explicit-any
    model.methods.start.execute(
      { maxPollAttempts: 1, pollIntervalMs: 0 },
      ctx as any,
    ));

  assertEquals(writes.length, 1);
  assertEquals(writes[0].specName, "serverStatus");
  assertEquals(writes[0].data.serverName, "web-1");
  assertEquals(writes[0].data.serverId, 42);
  assertEquals(writes[0].data.action, "start");
  assertEquals(writes[0].data.previousStatus, "off");
  assertEquals(writes[0].data.status, "running");
  assertEquals(writes[0].data.ipv4, "203.0.113.10");

  // Bearer auth is on every call
  assertEquals(calls[0].headers["authorization"], "Bearer tok");
  // Exactly one POST, and it is the poweron action
  const posts = calls.filter((c) => c.method === "POST");
  assertEquals(posts.length, 1);
  assertStringIncludes(posts[0].url, "/servers/42/actions/poweron");
});

// ---------------------------------------------------------------------------
// execute — stop
// ---------------------------------------------------------------------------

Deno.test("stop: powers off the server and writes off status", async () => {
  const writes: Array<
    { specName: string; name: string; data: Record<string, unknown> }
  > = [];
  const ctx = makeContext({ serverName: "web-1", token: "tok" }, writes);

  const { calls } = await withMockedFetch(async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/v1/servers") {
      return Response.json({ servers: [server(42, "web-1", "running")] });
    }
    if (url.pathname === "/v1/servers/42/actions/poweroff") {
      return Response.json(
        { action: { id: 8, status: "running", command: "poweroff" } },
        { status: 201 },
      );
    }
    if (url.pathname === "/v1/servers/42") {
      return Response.json({ server: server(42, "web-1", "off") });
    }
    return new Response("unexpected", { status: 500 });
  }, () =>
    // deno-lint-ignore no-explicit-any
    model.methods.stop.execute(
      { maxPollAttempts: 1, pollIntervalMs: 0 },
      ctx as any,
    ));

  assertEquals(writes.length, 1);
  assertEquals(writes[0].data.action, "stop");
  assertEquals(writes[0].data.previousStatus, "running");
  assertEquals(writes[0].data.status, "off");

  const posts = calls.filter((c) => c.method === "POST");
  assertEquals(posts.length, 1);
  assertStringIncludes(posts[0].url, "/servers/42/actions/poweroff");
});

// ---------------------------------------------------------------------------
// execute — error paths
// ---------------------------------------------------------------------------

Deno.test("start: throws a clear error when the server is not found", async () => {
  const ctx = makeContext({ serverName: "ghost", token: "tok" });

  await assertRejects(
    () =>
      withMockedFetch(
        () => Response.json({ servers: [] }),
        () =>
          // deno-lint-ignore no-explicit-any
          (model.methods.start as any).execute({}, ctx as any),
      ),
    Error,
    'No Hetzner Cloud server named "ghost"',
  );
});

Deno.test("start: surfaces an auth failure with guidance to set the vault token", async () => {
  const ctx = makeContext({ serverName: "web-1", token: "bad" });

  await assertRejects(
    () =>
      withMockedFetch(
        () =>
          Response.json(
            { error: { code: "unauthorized", message: "unauthorized" } },
            { status: 401 },
          ),
        () =>
          // deno-lint-ignore no-explicit-any
          (model.methods.start as any).execute({}, ctx as any),
      ),
    Error,
    "hetzner-api-token",
  );
});

Deno.test("start: throws when the server is already running and does not POST", async () => {
  const ctx = makeContext({ serverName: "web-1", token: "tok" });
  const methods: string[] = [];

  await assertRejects(
    () =>
      withMockedFetch(async (req) => {
        methods.push(req.method);
        return Response.json({ servers: [server(42, "web-1", "running")] });
      }, () =>
        // deno-lint-ignore no-explicit-any
        (model.methods.start as any).execute({}, ctx as any)),
    Error,
    "already running",
  );

  assertEquals(methods.includes("POST"), false);
});

Deno.test("stop: throws when the server is already powered off and does not POST", async () => {
  const ctx = makeContext({ serverName: "web-1", token: "tok" });
  const methods: string[] = [];

  await assertRejects(
    () =>
      withMockedFetch(async (req) => {
        methods.push(req.method);
        return Response.json({ servers: [server(42, "web-1", "off")] });
      }, () =>
        // deno-lint-ignore no-explicit-any
        (model.methods.stop as any).execute({}, ctx as any)),
    Error,
    "already powered off",
  );

  assertEquals(methods.includes("POST"), false);
});

Deno.test("start: surfaces a failure from the poweron action itself", async () => {
  const ctx = makeContext({ serverName: "web-1", token: "tok" });

  await assertRejects(
    () =>
      withMockedFetch(async (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/v1/servers") {
          return Response.json({ servers: [server(42, "web-1", "off")] });
        }
        return Response.json(
          { error: { code: "server_error", message: "backend exploded" } },
          { status: 500 },
        );
      }, () =>
        // deno-lint-ignore no-explicit-any
        (model.methods.start as any).execute({}, ctx as any)),
    Error,
    "poweron",
  );
});
