import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { call, asyncIteratorToUnproxiedDataStream } from "@orpc/server";
import { AppAgentThreadError } from "@patchsmith/agent/threads";
import {
  issueAgentToken,
  verifyAgentToken,
} from "@patchsmith/api-utils/agent-token";
import { asyncFixture } from "@patchsmith/config/testing";
import { readUIMessageStream } from "ai";
import { Effect } from "effect";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { createAgentStreamToken } from "#agent-stream-token";
import type { Context } from "#context";
import { env } from "#env";
import { canonicalizeScope } from "#scope";
import { attempt } from "#services";
import type { AgentInput, AgentRun, AgentStartOptions } from "#services";
import { createPlatformFixture } from "#test/platform";
import { testServices } from "#test/services";

const requireValue = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) {
    throw new Error("Expected a defined value.");
  }

  return value;
};

const mocks = {
  app: vi.fn(),
  getRun: vi.fn<(runId: string) => ReturnType<typeof run>>(),
  start:
    vi.fn<
      (input: AgentInput, options?: AgentStartOptions) => Promise<AgentRun>
    >(),
  thread: vi.fn<(appId: string, threadId?: string) => Promise<string>>(),
  token: vi.fn(),
};

const { appAgentRouter } = await import("./app-agent");
let context: Context;
let fixture: Awaited<ReturnType<typeof createPlatformFixture>>;

afterEach(async () => {
  await fixture.client.close();
});

const scope = canonicalizeScope({ name: "org", value: { tenant: "one" } });

const input = {
  body: {
    app: { id: "a3e7568a-c4f7-4ac0-8c35-71ff0f4cd002" },
    deployToken: "token",
    hostUrl: "http://localhost:3000/api/patchsmith",
    messages: [
      {
        id: "user-1",
        parts: [{ text: "Build", type: "text" }],
        role: "user" as const,
      },
    ],
    type: "turn" as const,
  },
};

const run = (parts: unknown[]) => ({
  cancel: vi.fn(),
  getReadable: () =>
    new ReadableStream({
      start(controller) {
        for (const part of parts) {
          controller.enqueue(part);
        }

        controller.enqueue({ type: "finish" });
        controller.close();
      },
    }),
  returnValue: Promise.resolve({ finishReason: "stop" }),
  runId: "wrun_test",
});

const consume = async (options?: { context: Context }) => {
  const chunks = await call(appAgentRouter.chat, input, options ?? { context });
  const events = [];

  for await (const event of chunks) {
    events.push(event);
  }

  return events;
};

beforeEach(async () => {
  fixture = await createPlatformFixture();
  vi.spyOn(fixture.db.query.app, "findFirst").mockImplementation(mocks.app);
  vi.spyOn(fixture.db.query.cliToken, "findFirst").mockImplementation(
    mocks.token
  );
  context = {
    ...testServices({
      agent: {
        getRun: (runId) => Effect.sync(() => mocks.getRun(runId)),
        resolveThread: (appId, threadId) =>
          attempt(async () => await mocks.thread(appId, threadId)),
        start: (agentInput, options) =>
          attempt(async () => await mocks.start(agentInput, options)),
      },
      database: fixture.db,
    }),
    organization: fixture.organization,
    project: { ...fixture.project, id: "project" },
    storage: {
      createDownloadUrl: vi.fn(),
      createUploadUrl: vi.fn(),
      delete: vi.fn(),
      head: vi.fn(),
      type: "s3",
    },
  };
  vi.clearAllMocks();
  mocks.thread.mockImplementation(
    async (_appId, id) =>
      await Promise.resolve(id ?? "e773a870-df5a-4bea-9ebd-9be4c0b1897a")
  );
  mocks.app.mockResolvedValue({ createdByAgent: true, id: "app-one" });
  mocks.token.mockResolvedValue({
    expiresAt: new Date(Date.now() + 3_600_000),
    id: "cli-one",
    scope: scope.scope,
    scopeKey: scope.scopeKey,
  });
  mocks.start.mockImplementation(
    asyncFixture(() =>
      run([
        { messageId: "assistant-1", type: "start" },
        { id: "text-1", type: "text-start" },
        { delta: "Hello", id: "text-1", type: "text-delta" },
        { id: "text-1", type: "text-end" },
        {
          input: {},
          toolCallId: "call-1",
          toolName: "write_file",
          type: "tool-input-available",
        },
      ])
    )
  );
});

describe("platform app chat", () => {
  it("rejects the old untyped request before starting a workflow", async () => {
    const handler = new OpenAPIHandler({ appAgent: appAgentRouter });

    const result = await handler.handle(
      new Request("https://platform.test/api/platform/app-agent/chat", {
        body: JSON.stringify({ ...input.body, type: undefined }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      { context, prefix: "/api/platform" }
    );

    expect(result.response?.status).toBe(400);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.getRun).not.toHaveBeenCalled();
  });
  it("reconnects to a signed run at the exact cursor without starting another workflow", async () => {
    const threadId = "e773a870-df5a-4bea-9ebd-9be4c0b1897a";
    const getReadable = vi.fn(run([{ type: "finish" }]).getReadable);
    mocks.getRun.mockReturnValue({ ...run([]), getReadable });

    const resume = {
      runId: "wrun_test",
      startIndex: 12,
      token: createAgentStreamToken("app-one", threadId, "wrun_test"),
    };

    const stream = await call(
      appAgentRouter.chat,
      {
        body: {
          app: { id: input.body.app.id },
          deployToken: input.body.deployToken,
          ...resume,
          threadId,
          type: "resume",
        },
      },
      { context }
    );

    const events = [];

    for await (const event of stream) {
      events.push(event);
    }

    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.thread).not.toHaveBeenCalled();
    expect(mocks.getRun).toHaveBeenCalledWith("wrun_test");
    expect(getReadable).toHaveBeenCalledWith({ startIndex: 12 });
    expect(events).toContainEqual({
      data: { runId: "wrun_test" },
      transient: true,
      type: "data-run-complete",
    });
  });

  it.each(["app-two", "another-thread", "tampered"])(
    "rejects a reconnect signed for %s before reading any run",
    async (mismatch) => {
      const threadId = "e773a870-df5a-4bea-9ebd-9be4c0b1897a";

      const resume = {
        runId: "wrun_test",
        startIndex: 0,
        token:
          mismatch === "tampered"
            ? "invalid"
            : createAgentStreamToken(
                mismatch === "app-two" ? mismatch : "app-one",
                mismatch === "another-thread" ? mismatch : threadId,
                "wrun_test"
              ),
      };

      await expect(
        call(
          appAgentRouter.chat,
          {
            body: {
              app: { id: input.body.app.id },
              deployToken: input.body.deployToken,
              ...resume,
              threadId,
              type: "resume",
            },
          },
          { context }
        )
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(mocks.start).not.toHaveBeenCalled();
      expect(mocks.getRun).not.toHaveBeenCalled();
    }
  );
  it("streams SDK chunks and starts each turn with the client's full UI history", async () => {
    const events = await consume();
    expect(events).toContainEqual({
      messageId: "assistant-1",
      type: "start",
    });
    expect(events).toContainEqual({
      delta: "Hello",
      id: "text-1",
      type: "text-delta",
    });
    expect(events.at(-1)).toEqual({
      data: { runId: "wrun_test" },
      transient: true,
      type: "data-run-complete",
    });
    const [first] = requireValue(mocks.start.mock.lastCall);
    expect(first.model).toBe("openai/gpt-6.1-sol");
    expect(first).not.toHaveProperty("deployToken");
    expect(
      await verifyAgentToken(
        first.agentToken,
        requireValue(env.AUTH_SECRET),
        env.OPENAPI_SERVER_URL ?? "https://patchsmith.io/api/platform"
      )
    ).toMatchObject({
      appId: "app-one",
      cliTokenId: "cli-one",
      projectId: context.project.id,
      scope: scope.scope,
    });
    expect(first.hostUrl).toBe(input.body.hostUrl);
    expect(first.schema).toBeUndefined();
    expect(first.messages).toEqual([
      { content: [{ text: "Build", type: "text" }], role: "user" },
    ]);

    const followup = [
      ...input.body.messages,
      {
        id: "assistant-1",
        parts: [
          {
            input: { path: "app.ts" },
            output: { success: true },
            state: "output-available",
            toolCallId: "tool-1",
            type: "tool-write",
          },
          { text: "Built", type: "text" },
        ],
        role: "assistant" as const,
      },
      {
        id: "user-2",
        parts: [{ text: "Continue", type: "text" }],
        role: "user" as const,
      },
    ];

    const stream = await call(
      appAgentRouter.chat,
      { body: { ...input.body, messages: followup } },
      { context }
    );

    for await (const _ of stream) {
      /* consume */
    }

    const [agentInput] = requireValue(mocks.start.mock.lastCall);
    expect(agentInput).toMatchObject({
      appId: first.appId,
    });
    expect(agentInput.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "tool" })])
    );
  });

  it("starts a fresh thread by default and announces its ID in the stream", async () => {
    const id = "e773a870-df5a-4bea-9ebd-9be4c0b1897a";
    const events = await consume();
    expect(mocks.thread).toHaveBeenCalledWith("app-one", undefined);
    expect(events).toContainEqual({
      data: {
        runId: "wrun_test",
        threadId: id,
        token: createAgentStreamToken("app-one", id, "wrun_test"),
      },
      transient: true,
      type: "data-run",
    });
    expect(requireValue(mocks.start.mock.lastCall)[0].threadId).toBe(id);
  });

  it("passes an explicit thread ID to the resolver and workflow", async () => {
    const threadId = "266f1673-2079-4e0c-9f68-6cf3f0f98a40";

    const stream = await call(
      appAgentRouter.chat,
      { body: { ...input.body, threadId } },
      { context }
    );

    for await (const _ of stream) {
      /* consume */
    }

    expect(mocks.thread).toHaveBeenCalledWith("app-one", threadId);
    expect(requireValue(mocks.start.mock.lastCall)[0].threadId).toBe(threadId);
  });

  it("rejects an unavailable thread before starting a workflow", async () => {
    const threadId = "266f1673-2079-4e0c-9f68-6cf3f0f98a40";
    const error = new AppAgentThreadError();
    mocks.thread.mockRejectedValueOnce(error);
    const handler = new OpenAPIHandler({ appAgent: appAgentRouter });

    const result = await handler.handle(
      new Request("https://platform.test/api/platform/app-agent/chat", {
        body: JSON.stringify({ ...input.body, threadId }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      { context, prefix: "/api/platform" }
    );

    const response = requireValue(result.response);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "BAD_REQUEST",
      defined: false,
      message: error.message,
    });
    expect(mocks.thread).toHaveBeenCalledWith("app-one", threadId);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("passes an optional schema snapshot to the workflow", async () => {
    const schema = {
      components: {},
      slots: {},
      tools: {},
      version: 1,
      views: {},
    };

    const stream = await call(
      appAgentRouter.chat,
      { body: { ...input.body, schema } },
      { context }
    );

    for await (const _ of stream) {
      /* consume */
    }

    expect(requireValue(mocks.start.mock.lastCall)[0]).toMatchObject({
      hostUrl: input.body.hostUrl,
      schema,
    });
  });

  it.each([undefined, "", "ftp://host.test", "localhost:3000"])(
    "rejects missing or invalid host URL %s before starting a workflow",
    async (hostUrl) => {
      const handler = new OpenAPIHandler({ appAgent: appAgentRouter });

      const result = await handler.handle(
        new Request("https://platform.test/api/platform/app-agent/chat", {
          body: JSON.stringify({ ...input.body, hostUrl }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
        { context, prefix: "/api/platform" }
      );

      expect(result.response?.status).toBe(400);
      expect(await result.response?.json()).toMatchObject({
        code: "BAD_REQUEST",
        message: "Input validation failed",
      });
      expect(mocks.start).not.toHaveBeenCalled();
    }
  );

  it("uses SDK resets without losing completed tool parts", async () => {
    mocks.start.mockResolvedValueOnce(
      run([
        {
          input: {},
          toolCallId: "call-1",
          toolName: "write",
          type: "tool-input-available",
        },
        {
          input: {},
          output: { success: true },
          toolCallId: "call-1",
          toolName: "write",
          type: "tool-output-available",
        },
        { type: "finish-step" },
        { type: "start-step" },
        { id: "old", type: "text-start" },
        { delta: "discard me", id: "old", type: "text-delta" },
        { type: "reset-step" },
        { id: "new", type: "text-start" },
        { delta: "Built", id: "new", type: "text-delta" },
        { id: "new", type: "text-end" },
      ])
    );
    const chunks = await call(appAgentRouter.chat, input, { context });
    let latest;

    for await (const message of readUIMessageStream({
      stream: asyncIteratorToUnproxiedDataStream(chunks),
      terminateOnError: true,
    })) {
      latest = message;
    }

    expect(latest?.parts).toContainEqual(
      expect.objectContaining({ state: "output-available", type: "tool-write" })
    );
    expect(latest?.parts).toContainEqual(
      expect.objectContaining({ text: "Built", type: "text" })
    );
    expect(latest?.parts).not.toContainEqual(
      expect.objectContaining({ text: "discard me" })
    );
  });

  it("uses the authorized app's canonical ID across tokens and aliases", async () => {
    await consume();
    expect(requireValue(mocks.start.mock.lastCall)[0].appId).toBe("app-one");
    mocks.token.mockResolvedValueOnce({
      expiresAt: new Date(Date.now() + 1000),
      id: "cli-two",
      scope: scope.scope,
      scopeKey: scope.scopeKey,
    });
    await consume();
    expect(requireValue(mocks.start.mock.lastCall)[0].appId).toBe("app-one");
  });

  it("rejects apps outside the authenticated project and scope", async () => {
    mocks.app.mockResolvedValue(null);
    await expect(consume()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("rejects manually created apps before starting a workflow", async () => {
    mocks.app.mockResolvedValueOnce({
      createdByAgent: false,
      id: "manual-app",
    });
    await expect(consume()).rejects.toMatchObject({
      code: "FORBIDDEN",
      message:
        "The agent can only edit apps created by AI. Create a new app to continue.",
    });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("rejects manually created apps before resuming a workflow", async () => {
    const threadId = "e773a870-df5a-4bea-9ebd-9be4c0b1897a";
    mocks.app.mockResolvedValueOnce({
      createdByAgent: false,
      id: "manual-app",
    });
    await expect(
      call(
        appAgentRouter.chat,
        {
          body: {
            app: { id: input.body.app.id },
            deployToken: input.body.deployToken,
            runId: "wrun_test",
            startIndex: 0,
            threadId,
            token: createAgentStreamToken("manual-app", threadId, "wrun_test"),
            type: "resume",
          },
        },
        { context }
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.getRun).not.toHaveBeenCalled();
    expect(mocks.thread).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("waits for workflow cleanup before finishing the response", async () => {
    let finish!: () => void;

    const returnValue = (async () => {
      const {
        promise: pendingPromise,
        resolve,
        reject: rejectPending,
      } = Promise.withResolvers<ReturnType<() => void>>();

      try {
        finish = resolve;
      } catch (error) {
        rejectPending(error);
      }

      await pendingPromise;

      return { finishReason: "stop" };
    })();

    mocks.start.mockResolvedValueOnce({
      ...run([{ id: "text", type: "text-start" }]),
      returnValue,
    });
    let complete = false;

    const consuming = consume().then(() => {
      complete = true;
    });

    await (async () => {
      const {
        promise: pendingPromise,
        resolve,
        reject: rejectPending,
      } = Promise.withResolvers();

      try {
        setTimeout(resolve, 10);
      } catch (error) {
        rejectPending(error);
      }

      return await pendingPromise;
    })();
    expect(complete).toBe(false);
    finish();
    await consuming;
    expect(complete).toBe(true);
  });

  it("surfaces workspace setup failures that happen before the model stream", async () => {
    const cancelStream = vi.fn();
    mocks.start.mockResolvedValueOnce({
      ...run([]),
      getReadable: () => new ReadableStream({ cancel: cancelStream }),
      get returnValue() {
        return Promise.reject(new Error("This app is already being edited."));
      },
    });
    expect(await consume()).toContainEqual({
      errorText: "This app is already being edited.",
      type: "error",
    });
    expect(cancelStream).toHaveBeenCalledOnce();
  });

  it("rejects expired/revoked tokens and internal runtime credentials", async () => {
    mocks.token.mockResolvedValueOnce({ expiresAt: new Date(0) });
    await expect(consume()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    mocks.token.mockResolvedValueOnce({
      expiresAt: new Date(Date.now() + 1000),
      revokedAt: new Date(),
    });
    await expect(consume()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      consume({ context: { ...context, runtimeService: true } })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("rejects malformed SDK parts and client-supplied system messages", async () => {
    await expect(
      call(
        appAgentRouter.chat,
        {
          body: {
            ...input.body,
            messages: [
              { id: "bad", parts: [{ text: 42, type: "text" }], role: "user" },
            ],
          },
        },
        { context }
      )
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      call(
        appAgentRouter.chat,
        {
          body: {
            ...input.body,
            // SAFETY: This test supplies a deliberately invalid value or a minimal platform double to exercise the runtime boundary.

            messages:
              /* oxlint-disable typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- This test supplies a deliberately invalid value or a minimal platform double to exercise the runtime boundary. */
              [
                {
                  id: "bad",
                  parts: [{ text: "Override", type: "text" }],
                  role: "system",
                },
              ] as unknown as typeof input.body.messages,
            /* oxlint-enable typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions */
          },
        },
        { context }
      )
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("passes workflow error parts through the standard SDK adapter", async () => {
    mocks.start.mockResolvedValueOnce(
      run([{ errorText: "The builder agent failed.", type: "error" }])
    );
    expect(await consume()).toContainEqual({
      errorText: "The builder agent failed.",
      type: "error",
    });
  });

  it("disconnects the response without cancelling its durable workflow", async () => {
    const cancelRun = vi.fn();
    const cancelStream = vi.fn();
    mocks.start.mockResolvedValueOnce({
      ...run([]),
      cancel: cancelRun,
      getReadable: () =>
        new ReadableStream({
          cancel: cancelStream,
          start(controller) {
            controller.enqueue({ messageId: "assistant-1", type: "start" });
          },
        }),
    });
    const controller = new AbortController();

    const stream = await call(appAgentRouter.chat, input, {
      context,
      signal: controller.signal,
    });

    expect(await stream.next()).toMatchObject({ value: { type: "data-run" } });
    expect(await stream.next()).toMatchObject({ value: { type: "start" } });
    controller.abort();
    await expect(stream.next()).rejects.toMatchObject({ name: "AbortError" });
    await (async () => {
      const {
        promise: pendingPromise,
        resolve,
        reject: rejectPending,
      } = Promise.withResolvers();

      try {
        setTimeout(resolve, 0);
      } catch (error) {
        rejectPending(error);
      }

      return await pendingPromise;
    })();
    expect(cancelStream).toHaveBeenCalledOnce();
    expect(cancelRun).not.toHaveBeenCalled();
  });
});

it("accepts another app in the JWT scope without extending the original deadline", async () => {
  mocks.app.mockResolvedValue({ createdByAgent: true, id: "app-two" });

  const jwt = await issueAgentToken(
    {
      appId: "app-one",
      cliTokenId: "cli-one",
      projectId: context.project.id,
      scope: scope.scope,
    },
    requireValue(env.AUTH_SECRET),
    requireValue(env.OPENAPI_SERVER_URL)
  );

  const agentToken = {
    ...(await verifyAgentToken(
      jwt,
      requireValue(env.AUTH_SECRET),
      requireValue(env.OPENAPI_SERVER_URL)
    )),
    token: jwt,
  };

  const events = await call(
    appAgentRouter.chat,
    { body: { ...input.body, deployToken: jwt } },
    { context: { ...context, agentToken } }
  );

  for await (const _ of events) {
    /* consume */
  }

  expect(requireValue(mocks.start.mock.lastCall)[0]).toMatchObject({
    agentToken: jwt,
    appId: "app-two",
  });
  expect(mocks.token).not.toHaveBeenCalled();
});

it("forwards host guidance separately from user messages", async () => {
  const chunks = await call(
    appAgentRouter.chat,
    {
      body: { ...input.body, instructions: "Use the host design system." },
    },
    { context }
  );

  for await (const _event of chunks) {
    /* consume */
  }

  const [workflowInput] = requireValue(mocks.start.mock.lastCall);
  expect(workflowInput.instructions).toBe("Use the host design system.");
  expect(workflowInput.messages).toEqual([
    { content: [{ text: "Build", type: "text" }], role: "user" },
  ]);
});
