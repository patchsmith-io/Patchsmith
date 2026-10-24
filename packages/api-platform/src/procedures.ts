import { middlewareGen } from "@orpc/experimental-effect";
import { openapi } from "@orpc/openapi";
import { ORPCError, os } from "@orpc/server";
import { devDelayMiddleware } from "@patchsmith/api-utils/dev-delay";
import { ratelimitMiddleware } from "@patchsmith/api-utils/rate-limiting";
import type { Scope } from "@patchsmith/db/schema/scope";
import { setSpanAttributes } from "@patchsmith/observability";
import { Effect } from "effect";

import type { AppSelector } from "#app-selector";
import {
  attempt,
  buildPlatformContext,
  PlatformDatabase,
  PlatformRateLimiter,
  runPlatform,
} from "#services";

import type { Context } from "./context";
import { canonicalizeScope, canonicalizeScopes, scopeMatches } from "./scope";

const isObjectValue = <TValue>(value: TValue): value is TValue & object =>
  typeof value === "object" && value !== null;

const requireValue = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) {
    throw new Error("Expected a defined value.");
  }

  return value;
};

type CanonicalScope = ReturnType<typeof canonicalizeScope>;

export const findAppInScopesEffect = (
  projectId: string,
  selector: AppSelector,
  scopes: CanonicalScope[]
) =>
  Effect.gen(function* findAppInScopes() {
    const db = yield* PlatformDatabase;

    const app = yield* attempt(
      async () =>
        await db.query.app.findFirst({
          where: {
            projectId,
            ...selector,
            RAW: (fields, { and, eq, or }) =>
              requireValue(
                and(
                  or(
                    ...scopes.map(({ scope, scopeKey }) =>
                      and(
                        eq(fields.scopeKey, scopeKey),
                        eq(fields.scope, scope)
                      )
                    )
                  )
                )
              ),
          },
          with: {
            currentDeployment: {
              where: { status: "published" },
              with: { app: { columns: { shortId: true } } },
            },
          },
        })
    );

    if (!app) {
      return yield* Effect.fail(new ORPCError("NOT_FOUND"));
    }

    return app;
  });

export const findAppInScopes = async (
  projectId: string,
  selector: AppSelector,
  scopes: CanonicalScope[],
  context?: Context
) =>
  await runPlatform(
    findAppInScopesEffect(projectId, selector, scopes),
    context
  );

export const o = os
  .$context<Context>()
  .use(
    async ({ context, next }) =>
      await next({
        context: {
          "effect/context":
            context["effect/context"] ?? (await buildPlatformContext()),
        },
      })
  )
  .meta(
    openapi({
      inputStructure: "detailed",
      outputStructure: "detailed",
    })
  );

const yieldLimiter = (context: Context) => {
  const services = context["effect/context"];

  if (!services) {
    throw new Error("Platform services missing");
  }

  return Effect.runSync(Effect.provide(PlatformRateLimiter, services));
};

const authenticatedRouter = o
  .use(devDelayMiddleware)
  .use(async (options, input, done) => {
    const limiter = yieldLimiter(options.context);

    return await ratelimitMiddleware(
      limiter,
      () => options.context.organization.id
    )(options, input, done);
  });

/** Existing CLI operations accept either credential with the same project/scope boundary. */
export const cliRouter = authenticatedRouter.use(
  middlewareGen(function* authorizeCliScope({ context, next }, input) {
    const { agentToken: agent } = context;

    if (agent) {
      const body =
        isObjectValue(input) && "body" in input ? input.body : undefined;

      const requestedScope =
        isObjectValue(body) && "scope" in body ? body.scope : undefined;

      const scopesValue =
        isObjectValue(body) && "scopes" in body ? body.scopes : undefined;

      if (requestedScope !== undefined || scopesValue !== undefined) {
        const authorized = yield* Effect.try({
          catch: () =>
            new ORPCError("FORBIDDEN", {
              message: "Requested scope is not authorized by the agent token.",
            }),
          try: () => {
            const scopes = [
              ...(requestedScope === undefined
                ? []
                : [canonicalizeScope(requestedScope)]),
              ...(scopesValue === undefined
                ? []
                : canonicalizeScopes(scopesValue)),
            ];

            return (
              scopes.length > 0 &&
              scopes.every(({ scope }) => scopeMatches(scope, agent.scope))
            );
          },
        });

        if (!authorized) {
          return yield* Effect.fail(
            new ORPCError("FORBIDDEN", {
              message: "Requested scope is not authorized by the agent token.",
            })
          );
        }
      }
    }

    // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- oRPC preserves downstream procedure failures.
    return yield* next();
  })
);

export const protectedRouter = authenticatedRouter.use(
  middlewareGen(function* requireHostCredential({ context, next }) {
    if (context.agentToken) {
      return yield* Effect.fail(new ORPCError("FORBIDDEN"));
    }

    // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- oRPC preserves downstream procedure failures.
    return yield* next();
  })
);

export const requireApp = o.middleware(
  middlewareGen(function* requireApp(
    { context, next },
    input: { app: AppSelector; scope: Scope }
  ) {
    setSpanAttributes({
      "patchsmith.middleware": "require_app",
      "patchsmith.package": "api-platform",
      "patchsmith.resource_type": "app",
    });

    const app = yield* findAppInScopesEffect(context.project.id, input.app, [
      canonicalizeScope(input.scope),
    ]);

    // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- oRPC preserves downstream procedure failures.
    return yield* next({ context: { ...context, app } });
  })
);

export const requireAppInScopes = o.middleware(
  middlewareGen(function* requireAppInScopes(
    { context, next },
    input: { app: AppSelector; scopes: Scope[] }
  ) {
    setSpanAttributes({
      "patchsmith.middleware": "require_app",
      "patchsmith.package": "api-platform",
      "patchsmith.resource_type": "app",
    });

    const app = yield* findAppInScopesEffect(
      context.project.id,
      input.app,
      canonicalizeScopes(input.scopes)
    );

    // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- oRPC preserves downstream procedure failures.
    return yield* next({ context: { ...context, app } });
  })
);
