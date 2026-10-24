import { randomBytes } from "node:crypto";

import { call, ORPCError } from "@orpc/server";
import { createAppAgentMcp } from "@patchsmith/agent/mcp";
import type {
  AppAgentMcpExecution,
  AppAgentMcpResult,
} from "@patchsmith/agent/mcp";
import { AppAgentThreadError } from "@patchsmith/agent/threads";
import { issueAgentToken } from "@patchsmith/api-utils/agent-token";
import { hashSecret } from "@patchsmith/api-utils/hashing";
import { cliToken } from "@patchsmith/db/schema/cli-auth";
import { sanitizeErrorForLog } from "@patchsmith/observability";
import type { UIMessageChunk } from "ai";
import { eq } from "drizzle-orm";
import { Clock, Effect } from "effect";
import { z } from "zod";

import {
  attempt,
  PlatformAgent,
  PlatformConfig,
  PlatformDatabase,
  runPlatform,
} from "#services";

import type { Context } from "./context";
import { findAppInScopesEffect, protectedRouter } from "./procedures";
import {
  canonicalizeScope,
  canonicalizeScopes,
  scopeValueSchema,
} from "./scope";

interface AgentRunAttributes {
  "patchsmith.projectId": string;
  [name: string]: string;
}

const contextSchema = z.strictObject({
  hostUrl: z.url({ protocol: /^https?$/u }),
  instructions: z.string().max(32_000).optional(),
  scopes: z.record(z.string(), scopeValueSchema),
  subjectId: z.string().min(1).max(256),
});

/** Standard MCP endpoint. Host project keys authenticate caller context carried in headers. */
export const handleAppAgentMcpRequest = async (
  request: Request,
  context: Context
): Promise<Response> => {
  if (context.runtimeService === true || context.agentToken) {
    return new Response("Forbidden", { status: 403 });
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed", {
      headers: { allow: "POST" },
      status: 405,
    });
  }

  let input: z.infer<typeof contextSchema>;
  let scopes: ReturnType<typeof canonicalizeScopes>;

  try {
    const encoded = request.headers.get("x-patchsmith-context");

    if (
      !(encoded !== undefined && encoded !== null && encoded !== "") ||
      encoded.length > 8192 ||
      !/^[A-Za-z0-9_-]+$/u.test(encoded)
    ) {
      throw new Error("Invalid MCP context header");
    }

    const bytes = Buffer.from(encoded, "base64url");

    if (bytes.toString("base64url") !== encoded) {
      throw new Error("Invalid MCP context encoding");
    }

    input = contextSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    );
    scopes = canonicalizeScopes(
      Object.entries(input.scopes).map(([name, value]) => ({ name, value }))
    );
    const host = new URL(input.hostUrl);

    if (host.username || host.password || host.search || host.hash) {
      throw new Error("Invalid host URL");
    }

    const origin = request.headers.get("origin");

    if (
      origin !== undefined &&
      origin !== null &&
      origin !== "" &&
      origin !== host.origin
    ) {
      return new Response("Forbidden origin", { status: 403 });
    }
  } catch {
    return new Response("Invalid MCP context header", { status: 400 });
  }

  const authorizedScopes = scopes.map(({ scope }) => scope);

  const runAgent = async (
    appId: string,
    prompt: string,
    execution: AppAgentMcpExecution,
    requestedThreadId?: string
  ): Promise<AppAgentMcpResult> =>
    await runPlatform(
      Effect.gen(function* runAuthorizedAgent() {
        const db = yield* PlatformDatabase;
        const config = yield* PlatformConfig;
        const agent = yield* PlatformAgent;

        const app = yield* findAppInScopesEffect(
          context.project.id,
          z.uuid().safeParse(appId).success
            ? { id: appId }
            : { shortId: appId },
          scopes
        );

        const secret = config.AUTH_SECRET;

        if (secret === undefined || secret === "") {
          return yield* Effect.fail(new ORPCError("SERVICE_UNAVAILABLE"));
        }

        const threadId = yield* agent
          .resolveThread(app.id, requestedThreadId)
          .pipe(
            Effect.mapError((error) => {
              const cause = "cause" in error ? error.cause : error;

              return cause instanceof AppAgentThreadError
                ? new ORPCError("BAD_REQUEST", { message: cause.message })
                : error;
            })
          );

        const now = yield* Clock.currentTimeMillis;

        const acquireGrant = Effect.gen(function* acquireGrant() {
          const [grant] = yield* attempt(
            async () =>
              await db
                .insert(cliToken)
                .values({
                  projectId: context.project.id,
                  ...canonicalizeScope(app.scope),
                  expiresAt: new Date(now + 3_600_000),
                  tokenHash: hashSecret(
                    randomBytes(32).toString("base64url"),
                    secret
                  ),
                })
                .returning()
          );

          if (!grant) {
            return yield* Effect.fail(new ORPCError("SERVICE_UNAVAILABLE"));
          }

          return grant;
        });

        return yield* Effect.acquireUseRelease(
          acquireGrant,
          (grant) =>
            Effect.gen(function* useGrant() {
              const agentToken = yield* attempt(
                async () =>
                  await issueAgentToken(
                    {
                      appId: app.id,
                      cliTokenId: grant.id,
                      projectId: context.project.id,
                      scope: app.scope,
                    },
                    secret,
                    config.OPENAPI_SERVER_URL ??
                      "https://patchsmith.io/api/platform"
                  )
              );

              const attributes: AgentRunAttributes = {
                "patchsmith.projectId": context.project.id,
                "patchsmith.subjectId": input.subjectId,
              };

              let finished = false;

              return yield* Effect.acquireUseRelease(
                agent.start(
                  {
                    agentToken,
                    appId: app.id,
                    hostUrl: input.hostUrl,
                    instructions: input.instructions,
                    messages: [{ content: prompt, role: "user" }],
                    model: "openai/gpt-6.1-sol",
                    threadId,
                  },
                  { attributes }
                ),
                (run) =>
                  attempt(async (signal) => {
                    const controller = new AbortController();
                    const completed = run.returnValue;
                    // A workflow can reject before opening its readable stream.
                    void (async () => {
                      try {
                        await completed;
                      } catch (error) {
                        controller.abort(error);
                      }
                    })();

                    try {
                      await execution.onProgress({
                        appId: app.shortId,
                        runId: run.runId,
                        status: "started",
                        threadId,
                      });
                      let answer = "";

                      const stream = run
                        .getReadable()
                        .pipeThrough(
                          new TransformStream<UIMessageChunk, UIMessageChunk>(),
                          {
                            signal: AbortSignal.any([
                              signal,
                              controller.signal,
                            ]),
                          }
                        );

                      for await (const chunk of stream) {
                        // oxlint-disable-next-line no-await-in-loop -- Preserve progress ordering within this agent stream.
                        await execution.onProgress({
                          appId: app.shortId,
                          chunk,
                          runId: run.runId,
                          status: "streaming",
                          threadId,
                        });

                        if (chunk.type === "text-delta") {
                          answer += chunk.delta;
                        } else if (chunk.type === "text-end") {
                          answer += "\n\n";
                        } else if (
                          chunk.type === "error" ||
                          chunk.type === "abort"
                        ) {
                          throw new Error(
                            "App agent stopped before completing its response."
                          );
                        }
                      }

                      const output = await completed;
                      finished = true;

                      return {
                        answer: answer.trim() || "App agent run ended.",
                        appId: app.shortId,
                        finishReason: output.finishReason,
                        runId: run.runId,
                        threadId,
                      };
                    } finally {
                      controller.abort();
                    }
                  }),
                (run) => {
                  if (finished) {
                    return Effect.void;
                  }

                  return attempt(async () => {
                    await run.cancel({
                      cancelReason:
                        "MCP request ended before its agent completed",
                    });
                  }).pipe(
                    Effect.catch((error) =>
                      Effect.sync(() => {
                        console.warn("App agent MCP cancellation failed", {
                          error: sanitizeErrorForLog(error),
                          runId: run.runId,
                        });
                      })
                    ),
                    Effect.ensuring(
                      agent.cancel(app.id, run.runId).pipe(Effect.orDie)
                    )
                  );
                }
              );
            }),
          (grant) =>
            Effect.gen(function* revokeGrant() {
              const revokedAt = new Date(yield* Clock.currentTimeMillis);
              yield* attempt(async () => {
                await db
                  .update(cliToken)
                  .set({ revokedAt })
                  .where(eq(cliToken.id, grant.id));
              });
            }).pipe(Effect.orDie)
        );
      }),
      context,
      execution.signal
    );

  const handler = createAppAgentMcp(
    {
      createApp: async (
        { scope: scopeName, prompt, ...metadata },
        execution
      ) => {
        execution.signal.throwIfAborted();

        const scope = authorizedScopes.find(
          (scopeValue) => scopeValue.name === scopeName
        );

        if (!scope) {
          throw new ORPCError("FORBIDDEN", {
            message: "Scope is not authorized by the host.",
          });
        }

        const { createAppRecord } = await import("./routes/apps");

        const app = await createAppRecord(
          context,
          {
            description: metadata.description ?? null,
            name: metadata.name,
            scope,
          },
          true
        );

        return await runAgent(app.id, prompt, execution);
      },
      editApp: async ({ appId, prompt, threadId }, execution) =>
        await call(
          protectedRouter.handler(
            async () => await runAgent(appId, prompt, execution, threadId)
          ),
          undefined,
          { context }
        ),
      listApps: async (pagination) => {
        const { appRouter } = await import("./routes/apps");

        const { body } = await call(
          appRouter.list,
          { body: { ...pagination, scopes: authorizedScopes } },
          { context }
        );

        return body;
      },
    },
    authorizedScopes.map(({ name }) => name)
  );

  const response = await handler.fetch(request);
  response.headers.set("cache-control", "no-store");
  response.headers.set("x-accel-buffering", "no");

  return response;
};
