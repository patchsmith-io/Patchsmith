import { randomBytes, randomInt } from "node:crypto";

import { handlerGen } from "@orpc/experimental-effect";
import { openapi } from "@orpc/openapi";
import { ORPCError } from "@orpc/server";
import { hashSecret } from "@patchsmith/api-utils/hashing";
import { cliAuthSession, cliToken } from "@patchsmith/db/schema/cli-auth";
import { and, eq, gt } from "drizzle-orm";
import { Clock, Effect } from "effect";
import { z } from "zod";

import { authenticateCliRequestEffect } from "#cli-token";
import { o, protectedRouter, cliRouter } from "#procedures";
import { canonicalizeScope, scopeSchema } from "#scope";
import { attempt, PlatformDatabase, PlatformConfig } from "#services";

const deviceCodeBytes = 32;
const deployTokenBytes = 32;
const userCodeLength = 9;
const userCodeSections = 3;

// 5 minutes
const authExpiresInMilliseconds = 5 * 60 * 1000;

// 12 hours
const tokenExpiresInMilliseconds = 12 * 60 * 60 * 1000;

// Skip out some characters to avoid confusion with similar characters (e.g. 0/O, 1/I, etc.)
const userCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const cliSecret = Effect.gen(function* cliSecret() {
  const config = yield* PlatformConfig;
  const secret = config.AUTH_SECRET;

  if (secret === undefined || secret === "") {
    return yield* Effect.fail(
      new ORPCError("SERVICE_UNAVAILABLE", {
        message: "AUTH_SECRET is required for CLI auth secret hashing.",
      })
    );
  }

  return (value: string) => hashSecret(value, secret);
});

const generateSecret = (bytes: number): string =>
  randomBytes(bytes).toString("base64url");

const generateUserCode = (): string => {
  let code = "";

  for (let index = 0; index < userCodeLength; index += 1) {
    code += userCodeAlphabet.charAt(randomInt(userCodeAlphabet.length));
  }

  const sectionLength = Math.floor(userCodeLength / userCodeSections);

  const sections = [];

  for (let i = 0; i < userCodeSections; i += 1) {
    sections.push(code.slice(i * sectionLength, (i + 1) * sectionLength));
  }

  return sections.join("-");
};

const normalizeUserCode = (userCode: string): string =>
  userCode.trim().replaceAll("-", "").toUpperCase();

const startCliAuth = protectedRouter
  .meta(
    openapi({
      method: "POST",
      path: "/start",
    })
  )
  .input(z.object({ body: z.object({}) }))
  .output(
    z.object({
      body: z.object({
        deviceCode: z.string(),
        expiresAt: z.date(),
        userCode: z.string(),
      }),
    })
  )
  .handler(
    handlerGen(function* startCliAuth({ context }) {
      const db = yield* PlatformDatabase;
      const hashCliSecret = yield* cliSecret;
      const now = new Date(yield* Clock.currentTimeMillis);

      const deviceCode = generateSecret(deviceCodeBytes);
      const userCode = generateUserCode();
      const expiresAt = new Date(now.getTime() + authExpiresInMilliseconds);

      yield* attempt(
        async () =>
          await db.insert(cliAuthSession).values({
            deviceCodeHash: hashCliSecret(deviceCode),
            expiresAt,
            projectId: context.project.id,
            userCodeHash: hashCliSecret(normalizeUserCode(userCode)),
          })
      );

      return {
        body: {
          deviceCode,
          expiresAt,
          userCode,
        },
      };
    })
  );

const approveCliAuth = protectedRouter
  .meta(
    openapi({
      method: "POST",
      path: "/approve",
    })
  )
  .input(
    z.object({
      body: z.object({
        scope: scopeSchema,
        userCode: z.string().min(1),
      }),
    })
  )
  .output(z.object({ body: z.object({ id: z.string() }) }))
  .handler(
    handlerGen(function* approveCliAuth({ context, input }) {
      const db = yield* PlatformDatabase;
      const hashCliSecret = yield* cliSecret;
      const now = new Date(yield* Clock.currentTimeMillis);

      const scope = canonicalizeScope(input.body.scope);

      const [session] = yield* attempt(
        async () =>
          await db
            .update(cliAuthSession)
            .set({
              scope: scope.scope,
              scopeKey: scope.scopeKey,
              status: "approved",
            })
            .where(
              and(
                eq(cliAuthSession.projectId, context.project.id),
                eq(
                  cliAuthSession.userCodeHash,
                  hashCliSecret(normalizeUserCode(input.body.userCode))
                ),
                eq(cliAuthSession.status, "pending"),
                gt(cliAuthSession.expiresAt, now)
              )
            )
            .returning({ id: cliAuthSession.id })
      );

      if (!session) {
        return yield* Effect.fail(
          new ORPCError("NOT_FOUND", {
            message: "CLI auth session not found.",
          })
        );
      }

      return { body: session };
    })
  );

const denyCliAuth = protectedRouter
  .meta(
    openapi({
      method: "POST",
      path: "/deny",
    })
  )
  .input(z.object({ body: z.object({ userCode: z.string().min(1) }) }))
  .output(z.object({ body: z.object({ id: z.string() }) }))
  .handler(
    handlerGen(function* denyCliAuth({ context, input }) {
      const db = yield* PlatformDatabase;
      const hashCliSecret = yield* cliSecret;
      const now = new Date(yield* Clock.currentTimeMillis);

      const [session] = yield* attempt(
        async () =>
          await db
            .update(cliAuthSession)
            .set({ status: "denied" })
            .where(
              and(
                eq(cliAuthSession.projectId, context.project.id),
                eq(
                  cliAuthSession.userCodeHash,
                  hashCliSecret(normalizeUserCode(input.body.userCode))
                ),
                eq(cliAuthSession.status, "pending"),
                gt(cliAuthSession.expiresAt, now)
              )
            )
            .returning({ id: cliAuthSession.id })
      );

      if (!session) {
        return yield* Effect.fail(
          new ORPCError("NOT_FOUND", {
            message: "CLI auth session not found.",
          })
        );
      }

      return { body: session };
    })
  );

const pollCliAuth = protectedRouter
  .meta(
    openapi({
      method: "POST",
      path: "/poll",
    })
  )
  .input(z.object({ body: z.object({ deviceCode: z.string().min(1) }) }))
  .output(
    z.object({
      body: z.discriminatedUnion("status", [
        z.object({ status: z.literal("pending") }),
        z.object({ status: z.literal("denied") }),
        z.object({
          deployToken: z.string(),
          scope: scopeSchema,
          status: z.literal("approved"),
        }),
        z.object({ status: z.literal("expired") }),
      ]),
    })
  )
  .handler(
    handlerGen(function* pollCliAuth({ context, input }) {
      const db = yield* PlatformDatabase;
      const hashCliSecret = yield* cliSecret;
      const now = new Date(yield* Clock.currentTimeMillis);

      const deviceCodeHash = hashCliSecret(input.body.deviceCode);

      const session = yield* attempt(
        async () =>
          await db.query.cliAuthSession.findFirst({
            where: {
              deviceCodeHash,
              projectId: context.project.id,
            },
          })
      );

      if (!session) {
        return yield* Effect.fail(
          new ORPCError("NOT_FOUND", {
            message: "CLI auth session not found.",
          })
        );
      }

      yield* attempt(
        async () =>
          await db
            .update(cliAuthSession)
            .set({ lastPolledAt: now })
            .where(eq(cliAuthSession.id, session.id))
      );

      if (session.expiresAt.getTime() <= now.getTime()) {
        return { body: { status: "expired" as const } };
      }

      if (session.status === "denied") {
        return { body: { status: "denied" as const } };
      }

      if (session.status === "pending") {
        return { body: { status: "pending" as const } };
      }

      if (
        !session.scope ||
        !(
          session.scopeKey !== undefined &&
          session.scopeKey !== null &&
          session.scopeKey !== ""
        )
      ) {
        return yield* Effect.fail(
          new ORPCError("BAD_REQUEST", {
            message: "Approved CLI auth session is missing scope.",
          })
        );
      }

      const sessionScope = yield* Effect.try({
        catch: () =>
          new ORPCError("BAD_REQUEST", {
            message: "Approved CLI auth session has an invalid scope.",
          }),
        try: () => canonicalizeScope(session.scope),
      });

      if (sessionScope.scopeKey !== session.scopeKey) {
        return yield* Effect.fail(
          new ORPCError("BAD_REQUEST", {
            message: "Approved CLI auth session has an invalid scope.",
          })
        );
      }

      const deployToken = generateSecret(deployTokenBytes);

      const deletedSession = yield* attempt(
        async () =>
          await db.transaction(async (tx) => {
            const [consumedSession] = await tx
              .delete(cliAuthSession)
              .where(
                and(
                  eq(cliAuthSession.id, session.id),
                  eq(cliAuthSession.projectId, context.project.id),
                  eq(cliAuthSession.status, "approved"),
                  gt(cliAuthSession.expiresAt, now)
                )
              )
              .returning();

            if (!consumedSession) {
              return null;
            }

            if (
              !consumedSession.scope ||
              !(
                consumedSession.scopeKey !== undefined &&
                consumedSession.scopeKey !== null &&
                consumedSession.scopeKey !== ""
              )
            ) {
              throw new ORPCError("BAD_REQUEST", {
                message: "Approved CLI auth session is missing scope.",
              });
            }

            let consumedScope: ReturnType<typeof canonicalizeScope>;

            try {
              consumedScope = canonicalizeScope(consumedSession.scope);
            } catch {
              throw new ORPCError("BAD_REQUEST", {
                message: "Approved CLI auth session has an invalid scope.",
              });
            }

            if (consumedScope.scopeKey !== consumedSession.scopeKey) {
              throw new ORPCError("BAD_REQUEST", {
                message: "Approved CLI auth session has an invalid scope.",
              });
            }

            await tx.insert(cliToken).values({
              expiresAt: new Date(now.getTime() + tokenExpiresInMilliseconds),
              projectId: context.project.id,
              scope: consumedScope.scope,
              scopeKey: consumedScope.scopeKey,
              tokenHash: hashCliSecret(deployToken),
            });

            return { ...consumedSession, scope: consumedScope.scope };
          })
      );

      if (!deletedSession) {
        return yield* Effect.fail(
          new ORPCError("NOT_FOUND", {
            message: "CLI auth session not found.",
          })
        );
      }

      return {
        body: {
          deployToken,
          scope: deletedSession.scope,
          status: "approved" as const,
        },
      };
    })
  );

const verifyCliAuthToken = cliRouter
  .meta(
    openapi({
      method: "POST",
      path: "/verify-token",
    })
  )
  .input(z.object({ body: z.object({ deployToken: z.string().min(1) }) }))
  .output(z.object({ body: z.object({ scope: scopeSchema }) }))
  .handler(
    handlerGen(function* verifyCliAuthToken({ context, input }) {
      const db = yield* PlatformDatabase;
      const now = new Date(yield* Clock.currentTimeMillis);

      const token = yield* authenticateCliRequestEffect(
        context,
        input.body.deployToken
      );

      yield* attempt(
        async () =>
          await db
            .update(cliToken)
            .set({ lastUsedAt: now })
            .where(eq(cliToken.id, token.id))
      );

      return { body: { scope: token.scope } };
    })
  );

export const cliAuthRouter = o.meta(openapi({ prefix: "/cli-auth" })).router({
  approve: approveCliAuth,
  deny: denyCliAuth,
  poll: pollCliAuth,
  start: startCliAuth,
  verifyToken: verifyCliAuthToken,
});
