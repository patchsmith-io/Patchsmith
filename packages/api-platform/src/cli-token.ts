import { ORPCError } from "@orpc/server";
import { hashSecret } from "@patchsmith/api-utils/hashing";
import { Clock, Effect } from "effect";

import type { Context } from "#context";
import { canonicalizeScope } from "#scope";
import {
  attempt,
  PlatformConfig,
  PlatformDatabase,
  runPlatform,
} from "#services";

const invalidToken = () =>
  new ORPCError("UNAUTHORIZED", { message: "Invalid CLI deploy token." });

export const authenticateCliEffect = (
  projectId: string,
  deployToken: string,
  runtimeService?: boolean
) =>
  Effect.gen(function* authenticateCli() {
    if (runtimeService === true) {
      return yield* Effect.fail(new ORPCError("FORBIDDEN"));
    }

    const config = yield* PlatformConfig;

    if (config.AUTH_SECRET === undefined || config.AUTH_SECRET === "") {
      return yield* Effect.fail(new ORPCError("SERVICE_UNAVAILABLE"));
    }

    const database = yield* PlatformDatabase;
    const secret = config.AUTH_SECRET;

    const token = yield* attempt(
      async () =>
        await database.query.cliToken.findFirst({
          where: { projectId, tokenHash: hashSecret(deployToken, secret) },
        })
    );

    const now = yield* Clock.currentTimeMillis;

    if (!token || token.revokedAt || token.expiresAt.getTime() <= now) {
      return yield* Effect.fail(invalidToken());
    }

    const scope = yield* Effect.try({
      catch: invalidToken,
      try: () => canonicalizeScope(token.scope),
    });

    if (scope.scopeKey !== token.scopeKey) {
      return yield* Effect.fail(invalidToken());
    }

    return { ...token, ...scope };
  });

export const authenticateCliRequestEffect = (context: Context, token: string) =>
  Effect.gen(function* authenticateCliRequest() {
    if (!context.agentToken) {
      return yield* authenticateCliEffect(
        context.project.id,
        token,
        context.runtimeService
      );
    }

    const agent = context.agentToken;

    if (token !== agent.token || context.runtimeService === true) {
      return yield* Effect.fail(new ORPCError("UNAUTHORIZED"));
    }

    const scope = yield* Effect.try({
      catch: invalidToken,
      try: () => canonicalizeScope(agent.scope),
    });

    return {
      id: agent.cliTokenId,
      projectId: agent.projectId,
      ...scope,
      expiresAt: new Date(agent.exp * 1000),
    };
  });

export const authenticateCli = async (
  projectId: string,
  deployToken: string,
  runtimeService?: boolean
) =>
  await runPlatform(
    authenticateCliEffect(projectId, deployToken, runtimeService)
  );

export const authenticateCliRequest = async (context: Context, token: string) =>
  await runPlatform(authenticateCliRequestEffect(context, token), context);
