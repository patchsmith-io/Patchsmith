import { handlerGen } from "@orpc/experimental-effect";
import { openapi } from "@orpc/openapi";
import {
  eventIterator,
  ORPCError,
  streamToAsyncIteratorObject,
} from "@orpc/server";
import { AppAgentThreadError } from "@patchsmith/agent/threads";
import { issueAgentToken } from "@patchsmith/api-utils/agent-token";
import {
  asSchema,
  convertToModelMessages,
  createUIMessageStream,
  uiMessageChunkSchema,
  validateUIMessages,
} from "ai";
import type { UIMessageChunk } from "ai";
import { Effect } from "effect";
import { z } from "zod";

import {
  createAgentStreamToken,
  verifyAgentStreamToken,
} from "#agent-stream-token";
import { AppWithCurrentDeployment } from "#app-discovery";
import { appSelectorSchema } from "#app-selector";
import { authenticateCliRequestEffect } from "#cli-token";
import { findAppInScopesEffect, o, cliRouter } from "#procedures";
import { canonicalizeScope } from "#scope";
import { attempt, PlatformAgent, PlatformConfig } from "#services";
import type { AgentRun } from "#services";

import { createAppRecordEffect } from "./apps";

const require = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) {
    throw new Error("Expected a defined value.");
  }

  return value;
};

const APP_AGENT_MODEL = "openai/gpt-6.1-sol";

const chunkSchema = asSchema(uiMessageChunkSchema);

/** Use the SDK's validator so transport parts stay aligned with its protocol. */
const agentChunkSchema = z
  .custom<UIMessageChunk>(async (value) => {
    const awaitedResult1 = await chunkSchema.validate?.(value);

    return awaitedResult1?.success === true;
  })
  .describe("An AI SDK UIMessageChunk. Fields depend on the chunk type.");

/** Parts stay extensible; the platform validates their SDK shapes before running. */
const agentMessagesSchema = z
  .array(
    z.object({
      id: z.string().min(1),
      metadata: z.unknown().optional(),
      parts: z.array(z.looseObject({ type: z.string() })).min(1),
      role: z.enum(["user", "assistant"]),
    })
  )
  .min(1);

const agentTurnSchema = z.object({
  app: appSelectorSchema,
  hostUrl: z.url({ protocol: /^https?$/u }),
  instructions: z.string().max(32_000).optional(),
  messages: agentMessagesSchema,
  schema: z.record(z.string(), z.unknown()).optional(),
  threadId: z.uuid().optional(),
  type: z.literal("turn"),
});

const agentResumeSchema = z.object({
  app: appSelectorSchema,
  runId: z.string().startsWith("wrun_"),
  startIndex: z.number().int().nonnegative(),
  threadId: z.uuid(),
  token: z.string().min(1),
  type: z.literal("resume"),
});

const create = cliRouter
  .meta(openapi({ method: "POST", path: "/apps" }))
  .input(
    z.object({
      body: AppWithCurrentDeployment.pick({ description: true, name: true })
        .extend({
          deployToken: z.string().min(1),
          slug: AppWithCurrentDeployment.shape.slug.optional(),
        })
        .strict(),
    })
  )
  .output(z.object({ body: AppWithCurrentDeployment }))
  .handler(
    handlerGen(function* create({ context, input }) {
      const token = yield* authenticateCliRequestEffect(
        context,
        input.body.deployToken
      );

      return {
        body: yield* createAppRecordEffect(
          context,
          {
            description: input.body.description,
            name: input.body.name,
            scope: token.scope,
            slug: input.body.slug,
          },
          true
        ),
      };
    })
  );

const chat = cliRouter
  .meta(openapi({ method: "POST", outputStructure: "compact", path: "/chat" }))
  .input(
    z.object({
      body: z.discriminatedUnion("type", [
        agentTurnSchema.extend({ deployToken: z.string().min(1) }),
        agentResumeSchema.extend({ deployToken: z.string().min(1) }),
      ]),
    })
  )
  .output(eventIterator(agentChunkSchema))
  .handler(
    handlerGen(function* chat({ context, input, signal }) {
      const agentService = yield* PlatformAgent;
      const env = yield* PlatformConfig;

      const token = yield* authenticateCliRequestEffect(
        context,
        input.body.deployToken
      );

      const app = yield* findAppInScopesEffect(
        context.project.id,
        input.body.app,
        [canonicalizeScope(token.scope)]
      );

      if (!app.createdByAgent) {
        return yield* Effect.fail(
          new ORPCError("FORBIDDEN", {
            message:
              "The agent can only edit apps created by AI. Create a new app to continue.",
          })
        );
      }

      const { body } = input;
      let threadId: string;
      let run: AgentRun;
      let startIndex = 0;

      if (body.type === "resume") {
        if (
          !verifyAgentStreamToken(
            app.id,
            body.threadId,
            body.runId,
            body.token,
            env.AUTH_SECRET
          )
        ) {
          return yield* Effect.fail(
            new ORPCError("NOT_FOUND", {
              message: "Agent run not found for this app and thread.",
            })
          );
        }

        ({ threadId, startIndex } = body);
        run = yield* agentService.getRun(body.runId);
      } else {
        const messages = yield* Effect.tryPromise({
          catch: () =>
            new ORPCError("BAD_REQUEST", {
              message: "Invalid agent messages.",
            }),
          try: async () =>
            await convertToModelMessages(
              await validateUIMessages({ messages: body.messages })
            ),
        });

        threadId = yield* agentService
          .resolveThread(app.id, body.threadId)
          .pipe(
            Effect.mapError((error) => {
              const cause = "cause" in error ? error.cause : error;

              return cause instanceof AppAgentThreadError
                ? new ORPCError("BAD_REQUEST", { message: cause.message })
                : error;
            })
          );

        // Reuse an agent credential across its authorized scope without extending its expiry.
        const agentToken =
          context.agentToken?.token ??
          (yield* attempt(
            async () =>
              await issueAgentToken(
                {
                  appId: app.id,
                  cliTokenId: token.id,
                  projectId: context.project.id,
                  scope: token.scope,
                },
                require(env.AUTH_SECRET),
                env.OPENAPI_SERVER_URL ?? "https://patchsmith.io/api/platform"
              )
          ));

        run = yield* agentService.start({
          agentToken,
          appId: app.id,
          hostUrl: body.hostUrl,
          instructions: body.instructions,
          messages,
          model: APP_AGENT_MODEL,
          schema: body.schema,
          threadId,
        });
      }

      const streamToken = createAgentStreamToken(
        app.id,
        threadId,
        run.runId,
        env.AUTH_SECRET
      );

      return streamToAsyncIteratorObject(
        createUIMessageStream({
          execute: async ({ writer }) => {
            writer.write({
              data: { runId: run.runId, threadId, token: streamToken },
              transient: true,
              type: "data-run",
            });
            const controller = new AbortController();
            const completed = run.returnValue;
            writer.merge(
              run
                .getReadable({
                  startIndex,
                })
                .pipeThrough(
                  new TransformStream<UIMessageChunk, UIMessageChunk>({
                    async flush(stream) {
                      await completed;
                      stream.enqueue({
                        data: { runId: run.runId },
                        transient: true,
                        type: "data-run-complete",
                      });
                    },
                  }),
                  {
                    signal: controller.signal,
                  }
                )
            );

            try {
              // Finish the response only after cleanup releases the app's Drive.
              await completed;
            } catch (error) {
              // A busy Drive can fail before the workflow opens its model stream.
              controller.abort(error);
              throw error;
            }
          },
          onError: (error) =>
            error instanceof Error ? error.message : String(error),
        }),
        { signal }
      );
    })
  );

export const appAgentRouter = o
  .meta(openapi({ prefix: "/app-agent" }))
  .router({ chat, create });
