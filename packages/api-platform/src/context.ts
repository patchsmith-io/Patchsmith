import { ORPCError } from "@orpc/server";
import { verifyAgentToken } from "@patchsmith/api-utils/agent-token";
import type { AgentToken } from "@patchsmith/api-utils/agent-token";
import type { Organization } from "@patchsmith/db/schema/auth";
import type { Project } from "@patchsmith/db/schema/project";
import {
  initializeObservability,
  setSpanAttributes,
  withSpan,
} from "@patchsmith/observability";
import type { Storage } from "@patchsmith/storage";
import { Effect } from "effect";

import { PlatformDependencyError } from "#errors";
import { runtimeProjectAccessEffect } from "#runtime/access";
import { canonicalizeScope } from "#scope";
import {
  attempt,
  buildPlatformContext,
  PlatformConfig,
  PlatformCredentials,
  PlatformDatabase,
  PlatformStorage,
  runPlatform,
} from "#services";
import type { PlatformEffectContext } from "#services";

export interface Context extends Partial<PlatformEffectContext> {
  project: Project;
  organization: Organization;
  storage: Storage;
  /** Internal metadata-only access; not a project host credential. */
  runtimeService?: boolean;
  /** Alternative CLI authorization with the initiating credential's project and scope. */
  agentToken?: AgentToken & { token: string };
}

const invalidAgentToken = () =>
  new ORPCError("UNAUTHORIZED", {
    message: "Invalid or expired agent token. Start a new agent turn.",
  });

export const createContextEffect = (request: Request) =>
  Effect.gen(function* createContext() {
    const storageService = yield* PlatformStorage;
    const storage = yield* storageService.get;

    if (!storage) {
      return yield* Effect.fail(
        new ORPCError("SERVICE_UNAVAILABLE", {
          message: "Platform storage is unavailable.",
        })
      );
    }

    const [scheme, key] =
      request.headers.get("authorization")?.split(" ") ?? [];

    if (key === undefined || key === "") {
      return yield* Effect.fail(
        new ORPCError("UNAUTHORIZED", {
          message: "Authorization header not found",
        })
      );
    }

    if (scheme !== "Bearer") {
      return yield* Effect.fail(
        new ORPCError("UNAUTHORIZED", {
          message: "Invalid authorization scheme",
        })
      );
    }

    const config = yield* PlatformConfig;
    const database = yield* PlatformDatabase;

    const runtimeProject = yield* runtimeProjectAccessEffect(
      request,
      config.APP_RUNTIME_SERVICE_TOKEN
    );

    let projectId: string;
    let agentToken: Context["agentToken"];

    if (key.split(".").length === 3) {
      if (config.AUTH_SECRET === undefined || config.AUTH_SECRET === "") {
        return yield* Effect.fail(new ORPCError("SERVICE_UNAVAILABLE"));
      }

      const secret = config.AUTH_SECRET;

      const claims = yield* Effect.tryPromise({
        catch: invalidAgentToken,
        try: async () => {
          const verified = await verifyAgentToken(
            key,
            secret,
            config.OPENAPI_SERVER_URL ?? "https://patchsmith.io/api/platform"
          );

          canonicalizeScope(verified.scope);

          return verified;
        },
      });

      // Storage failures must remain distinct from rejected credentials.
      const source = yield* attempt(
        async () =>
          await database.query.cliToken.findFirst({
            where: { id: claims.cliTokenId, projectId: claims.projectId },
          })
      );

      const scope = canonicalizeScope(claims.scope);

      const validSource = yield* Effect.sync(() => {
        try {
          return Boolean(
            source &&
            !source.revokedAt &&
            source.scopeKey === scope.scopeKey &&
            canonicalizeScope(source.scope).scopeKey === scope.scopeKey
          );
        } catch {
          return false;
        }
      });

      if (!validSource) {
        return yield* Effect.fail(
          new ORPCError("UNAUTHORIZED", {
            message: "Agent authorization revoked. Start a new agent turn.",
          })
        );
      }

      agentToken = { ...claims, scope: scope.scope, token: key };
      ({ projectId } = agentToken);
    } else if (runtimeProject !== null && runtimeProject !== "") {
      projectId = runtimeProject;
    } else {
      const credentials = yield* PlatformCredentials;
      const apiKey = yield* credentials.verifyProjectKey(key);

      if (!apiKey.valid) {
        return yield* Effect.fail(
          new ORPCError("UNAUTHORIZED", { message: "Invalid API key" })
        );
      }

      if (apiKey.projectId === undefined || apiKey.projectId === "") {
        return yield* Effect.fail(
          new ORPCError("UNAUTHORIZED", {
            message: "Project ID not found in API key metadata",
          })
        );
      }

      ({ projectId } = apiKey);
    }

    const project = yield* attempt(
      async () =>
        await database.query.project.findFirst({
          where: { id: projectId },
          with: { organization: true },
        })
    );

    if (!project) {
      return yield* Effect.fail(
        new ORPCError("UNAUTHORIZED", { message: "Project not found" })
      );
    }

    if (!project.organization) {
      return yield* new PlatformDependencyError({
        cause: undefined,
        message: "Organization not found",
      });
    }

    yield* Effect.sync(() => {
      setSpanAttributes({
        "patchsmith.authenticated": true,
        "patchsmith.package": "api-platform",
        "patchsmith.resource_type": "project",
      });
    });

    return {
      agentToken,
      organization: project.organization,
      project,
      runtimeService: Boolean(runtimeProject),
      storage,
    };
  });

export const createContext = async ({
  request,
  ...injected
}: { request: Request } & Partial<PlatformEffectContext>): Promise<Context> => {
  await initializeObservability("patchsmith-web");
  const services = injected["effect/context"] ?? (await buildPlatformContext());

  return await withSpan("api_platform.create_context", async () => ({
    ...(await runPlatform(
      createContextEffect(request),
      { "effect/context": services },
      request.signal
    )),
    "effect/context": services,
  }));
};

/** Keep unavailable dependencies distinct from rejected credentials at the HTTP boundary. */
export const contextErrorResponse = (cause: unknown) => {
  if (cause instanceof ORPCError && cause.code === "UNAUTHORIZED") {
    return Response.json(
      { code: "UNAUTHORIZED", message: cause.message },
      { status: 401 }
    );
  }

  return Response.json(
    {
      code: "SERVICE_UNAVAILABLE",
      message: "Platform is temporarily unavailable.",
    },
    { status: 503 }
  );
};
