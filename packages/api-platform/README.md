# Patchsmith platform API

`@patchsmith/api-platform` implements the platform API for managing and running Patchsmith extensions.

## Finding code

- `src/routes/` contains HTTP endpoints. App CRUD and installations live in `apps.ts`; sessions, bundle metadata, and view resolution live in `app-runtime.ts`.
- `src/app-runtime/` contains app execution support: authentication, access, view resolution, and deployment warm-up workflows. This refers to the app runtime, separate from Effect's runtime.
- `src/deployments/verification.ts` inspects uploaded bundles and logos before publication.
- `src/services.ts` defines Effect services and production layers. `context.ts` builds request context; `procedures.ts` defines shared authorization middleware.
- Small shared modules stay in `src/`. `app-discovery.ts` shares app queries and response schemas between app and runtime routes.
- Tests sit beside the code they exercise. Route suites are split by behavior; `src/test/` contains shared database and service fixtures.

Use `@patchsmith/api-platform/app-runtime/*` and `@patchsmith/api-platform/routes/app-runtime` for the renamed modules. The previous `runtime/*` and `routes/runtime` package exports remain aliases.

## Connect to the app-agent MCP endpoint

Connect Model Context Protocol (MCP) clients to `POST /api/platform/app-agent/mcp`. The web app mounts this streaming HTTP endpoint using `handleAppAgentMcpRequest` from `@patchsmith/api-platform/app-agent-mcp`. Send an MCP JSON-RPC request body and the required MCP metadata headers. Responses use MCP Server-Sent Events (SSE).

The host's server-side client supplies two headers:

- `Authorization: Bearer your_project_key` authenticates the host. CLI agent JSON Web Tokens (JWTs) and runtime service credentials cannot use this endpoint.
- `X-Patchsmith-Context` contains unpadded base64url-encoded UTF-8 JSON with `{ scopes, subjectId, hostUrl }`. The endpoint enforces an 8 KiB limit and rejects invalid encodings, empty scopes, and unexpected fields.

`scopes` and required `subjectId` have the same shape as the object returned by `authenticate()`. The authenticated host asserts those values.

`hostUrl` is the configured public Patchsmith host API URL; the builder agent reads its `/schema` endpoint during generation. If an `Origin` header is present, it must match that host origin. A host proxy is not involved in MCP requests.

The typed `server.mcp.transport({ scopes, subjectId })` helper prepares the URL and headers, validates the scopes against the host contract, and handles encoding. Clients may also construct these headers directly, using their own MCP library.

App reads, creation, and edits use the authenticated project and exact canonical scope identities. Builder/editor agents receive a one-hour grant for the selected app's scope, using the existing CLI/JWT authorization and revocation checks. The platform revokes the source grant when the call finishes, fails, or is cancelled. The workflow records `subjectId` in its attributes for provenance.

See [the MCP tools, streaming contract, and compatibility requirements](../agent/README.md#mcp).

## Effect services and testing

Route handlers and authorization middleware compose Effects through oRPC's `handlerGen` and `middlewareGen`. `createContext` supplies services through `effect/context`. Existing Promise exports remain adapters for the web application, SDK callbacks, and durable workflow steps.

`src/services.ts` defines typed services for the database, configuration, HTTP transport, storage discovery, project credentials, short IDs, agent workflows, runtime operations, and rate limiting. `platformInfrastructureLayer` supplies production adapters. `platformRuntimeLayer` captures its database, configuration, and HTTP dependencies when built; `platformLayer` composes both. Workflow and auth SDK imports stay lazy.

Test an operation directly by providing the services it requires:

```ts
const result = await runPromise(
  authenticateCliEffect(projectId, token).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(PlatformDatabase, testDb),
        Layer.succeed(PlatformConfig, testConfig)
      )
    ),
    Effect.provide(TestClock.layer())
  )
);
```

For router and HTTP tests, `src/test/services.ts` builds request contexts from real layers and selected overrides. PGlite runs the actual migrations and Drizzle queries. Tests inject external transports and workflow capabilities, preserving the real authorization, validation, transaction, and serialization paths. Distinct request contexts can run concurrently without changing module state.

Infrastructure and SDK failures use `PlatformDependencyError`, retaining their original cause. Domain failures retain their oRPC codes. Authentication outages therefore remain distinct from invalid credentials. Tests cover project and scope isolation, token expiry and revocation, concurrent CLI token consumption and rollback, deployment verification and rollout, runtime selection and timeouts, and MCP grant cleanup on success, failure, and cancellation. Existing view-resolution tests exercise concurrent resolution, partial results, deadlines, and backend cleanup with Effect's test clock.

MCP agent runs and their temporary grants use `Effect.acquireUseRelease`; release runs during interruption as well as ordinary completion. Deployment verification processes files sequentially, and failure or cancellation restores their retryable deployment state. SDK transaction callbacks and durable workflow orchestration retain their required Promise interfaces.
