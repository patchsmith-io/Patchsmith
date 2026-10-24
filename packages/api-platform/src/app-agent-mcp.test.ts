import { AppAgentThreadError } from "@patchsmith/agent/threads";
import { verifyAgentToken } from "@patchsmith/api-utils/agent-token";
import type { UIMessageChunk } from "ai";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import type { z } from "zod";

import { handleAppAgentMcpRequest } from "#app-agent-mcp";
import type { Context } from "#context";
import { env } from "#env";
import { attempt } from "#services";
import type { AgentInput, AgentRun, AgentStartOptions } from "#services";
import { createPlatformFixture } from "#test/platform";
import { testServices } from "#test/services";

const threadId = "e773a870-df5a-4bea-9ebd-9be4c0b1897a";
const identity = { scopes: { org: { tenant: "one" } }, subjectId: "user" };

const start =
  vi.fn<
    (input: AgentInput, options?: AgentStartOptions) => Promise<AgentRun>
  >();

const cancel = vi.fn<AgentRun["cancel"]>();
const cleanup = vi.fn<(appId: string, runId: string) => Promise<void>>();
const thread = vi.fn<(appId: string, threadId?: string) => Promise<string>>();
let fixture: Awaited<ReturnType<typeof createPlatformFixture>>;
let context: Context;

const readable = (chunks: UIMessageChunk[] = []) =>
  new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }

      controller.close();
    },
  });

const run = (overrides: Partial<AgentRun> = {}): AgentRun => ({
  cancel,
  getReadable: () =>
    readable([{ delta: "Built calendar", id: "text", type: "text-delta" }]),
  returnValue: Promise.resolve({ finishReason: "stop" }),
  runId: "run",
  ...overrides,
});

const grants = async () => await fixture.db.query.cliToken.findMany();

const expectRevoked = async () => {
  const rows = await grants();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.revokedAt).toBeInstanceOf(Date);
};

const request = (
  name: string,
  args: z.infer<ReturnType<typeof z.json>> = {},
  overrides = {},
  headers = {}
) => {
  const contextValue = {
    ...identity,
    hostUrl: "https://host.test/api/patchsmith",
    ...overrides,
  };

  return new Request("https://platform.test/api/platform/app-agent/mcp", {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        _meta: {
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          progressToken: "progress",
        },
        arguments: args,
        name,
      },
    }),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-method": "tools/call",
      "mcp-name": name,
      "mcp-protocol-version": "2026-07-28",
      "x-patchsmith-context": Buffer.from(
        JSON.stringify(contextValue),
        "utf-8"
      ).toString("base64url"),
      ...headers,
    },
    method: "POST",
  });
};

beforeEach(async () => {
  vi.resetAllMocks();
  fixture = await createPlatformFixture();
  thread.mockImplementation(
    async (_appId, requested) => await Promise.resolve(requested ?? threadId)
  );
  start.mockResolvedValue(run());
  context = {
    ...testServices({
      agent: {
        cancel: (appId, runId) =>
          attempt(async () => {
            await cleanup(appId, runId);
          }),
        resolveThread: (appId, requested) =>
          attempt(async () => await thread(appId, requested)),
        start: (input, options) =>
          attempt(async () => await start(input, options)),
      },
      database: fixture.db,
    }),
    organization: fixture.organization,
    project: fixture.project,
    storage: {
      createDownloadUrl: vi.fn(),
      createUploadUrl: vi.fn(),
      delete: vi.fn(),
      head: vi.fn(),
      type: "s3",
    },
  };
});

afterEach(async () => {
  await fixture.client.close();
});

const edit = (extra: Record<string, string> = {}) =>
  request("edit_app", {
    appId: fixture.app.shortId,
    prompt: "Change calendar",
    ...extra,
  });

describe("platform MCP endpoint", () => {
  it("lists host-authorized apps without starting an agent", async () => {
    const response = await handleAppAgentMcpRequest(
      request("list_apps"),
      context
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain(fixture.app.shortId);
    expect(start).not.toHaveBeenCalled();
    expect(await grants()).toEqual([]);
  });
  it("issues an app-bound grant, streams the result, then revokes authorization", async () => {
    const response = await handleAppAgentMcpRequest(edit(), context);
    const body = await response.text();
    expect(body).toContain("Built calendar");
    expect(body).toContain(threadId);
    const input = start.mock.lastCall?.[0];
    expect(input).toMatchObject({
      appId: fixture.app.id,
      hostUrl: "https://host.test/api/patchsmith",
      model: "openai/gpt-6.1-sol",
    });
    expect(start.mock.lastCall?.[1]?.attributes).toEqual({
      "patchsmith.projectId": fixture.project.id,
      "patchsmith.subjectId": "user",
    });

    if (!input || env.AUTH_SECRET === undefined) {
      throw new Error("Missing issued credential");
    }

    const claims = await verifyAgentToken(
      input.agentToken,
      env.AUTH_SECRET,
      env.OPENAPI_SERVER_URL ?? "https://patchsmith.io/api/platform"
    );

    expect(claims).toMatchObject({
      appId: fixture.app.id,
      projectId: fixture.project.id,
      scope: fixture.scope.scope,
    });
    await expectRevoked();
    expect(cancel).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });
  it("reuses the requested thread and rejects unavailable threads before issuing grants", async () => {
    const response = await handleAppAgentMcpRequest(
      edit({ threadId }),
      context
    );

    await response.text();
    expect(thread).toHaveBeenLastCalledWith(fixture.app.id, threadId);
    thread.mockRejectedValueOnce(new AppAgentThreadError());

    const rejected = await handleAppAgentMcpRequest(
      edit({ threadId }),
      context
    );

    expect(await rejected.text()).toContain("Thread not found");
    expect(await grants()).toHaveLength(1);
  });
  it("creates a real app in the selected host scope before starting the builder", async () => {
    const response = await handleAppAgentMcpRequest(
      request("create_app", {
        name: "Inbox",
        prompt: "Build inbox",
        scope: "org",
      }),
      context
    );

    expect(await response.text()).not.toContain('"isError":true');

    const created = await fixture.db.query.app.findFirst({
      where: { name: "Inbox" },
    });

    expect(created).toMatchObject({
      createdByAgent: true,
      projectId: fixture.project.id,
      scope: fixture.scope.scope,
    });
    expect(start.mock.lastCall?.[0].appId).toBe(created?.id);
    await expectRevoked();
  });
  it.each(["missing", "scope"])(
    "rejects unauthorized %s selections before issuing grants",
    async (selection) => {
      const input =
        selection === "missing"
          ? request("edit_app", { appId: "other", prompt: "Change" })
          : request("create_app", {
              name: "Todo",
              prompt: "Build",
              scope: "other",
            });

      const response = await handleAppAgentMcpRequest(input, context);
      expect(await response.text()).toContain('"isError":true');
      expect(start).not.toHaveBeenCalled();
      expect(await grants()).toEqual([]);
    }
  );
  it.each(["error", "abort"] as const)(
    "cleans up a streamed %s without exposing diagnostics",
    async (type) => {
      start.mockResolvedValueOnce(
        run({
          getReadable: () =>
            readable([{ errorText: "Private diagnostics", type }]),
        })
      );
      const response = await handleAppAgentMcpRequest(edit(), context);
      const body = await response.text();
      expect(body).toContain('"isError":true');
      expect(body).not.toContain("Private diagnostics");
      expect(cancel).toHaveBeenCalledOnce();
      expect(cleanup).toHaveBeenCalledWith(fixture.app.id, "run");
      await expectRevoked();
    }
  );
  it("revokes a grant when workflow startup fails", async () => {
    start.mockRejectedValueOnce(new Error("Workflow unavailable"));
    const response = await handleAppAgentMcpRequest(edit(), context);
    expect(await response.text()).toContain("Workflow unavailable");
    await expectRevoked();
    expect(cancel).not.toHaveBeenCalled();
  });
  it("waits for workflow cleanup before sending its terminal result", async () => {
    const completed = Promise.withResolvers<{ finishReason: string }>();
    start.mockResolvedValueOnce(
      run({ getReadable: () => readable(), returnValue: completed.promise })
    );
    const response = await handleAppAgentMcpRequest(edit(), context);
    const consuming = response.text();
    await expect
      .poll(async () => {
        const rows = await grants();

        return rows.length;
      })
      .toBe(1);
    const rows = await grants();
    expect(rows[0]?.revokedAt).toBeNull();
    completed.resolve({ finishReason: "stop" });
    expect(await consuming).toContain('"finishReason":"stop"');
    await expectRevoked();
  });
  it("cancels and revokes on response cancellation, even when workflow cancellation fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    cancel.mockRejectedValueOnce(new Error("Cancellation unavailable"));
    start.mockResolvedValueOnce(
      run({
        getReadable: () => new ReadableStream(),
        returnValue: Promise.withResolvers<{ finishReason: string }>().promise,
      })
    );

    try {
      const response = await handleAppAgentMcpRequest(edit(), context);
      const reader = response.body?.getReader();

      if (!reader) {
        throw new Error("Missing response body");
      }

      await reader.read();
      await reader.cancel();
      await expect
        .poll(async () => {
          const rows = await grants();

          return rows[0]?.revokedAt;
        })
        .toBeInstanceOf(Date);
      expect(cancel).toHaveBeenCalledOnce();
      expect(cleanup).toHaveBeenCalledWith(fixture.app.id, "run");
      expect(warning).toHaveBeenCalledOnce();
    } finally {
      warning.mockRestore();
    }
  });
  it("cancels an unfinished agent after a stream failure", async () => {
    start.mockResolvedValueOnce(
      run({
        getReadable: () =>
          new ReadableStream({
            start(controller) {
              controller.error(new Error("Stream failed"));
            },
          }),
        returnValue: Promise.withResolvers<{ finishReason: string }>().promise,
      })
    );
    const response = await handleAppAgentMcpRequest(edit(), context);
    expect(await response.text()).toContain('"isError":true');
    expect(cleanup).toHaveBeenCalledWith(fixture.app.id, "run");
    await expectRevoked();
  });
  it("returns only the answer while excluding tools, reasoning, and workflow internals", async () => {
    const output = {
      finishReason: "stop",
      messages: [{ content: "Internal transcript" }],
      sessionId: "internal-session",
      usage: { inputTokens: 12 },
    };

    start.mockResolvedValueOnce(
      run({
        getReadable: () =>
          readable([
            {
              delta: "Private reasoning",
              id: "reason",
              type: "reasoning-delta",
            },
            {
              input: { content: "Large source code" },
              toolCallId: "write",
              toolName: "write_file",
              type: "tool-input-available",
            },
            {
              output: "Large tool output",
              toolCallId: "write",
              type: "tool-output-available",
            },
            { delta: "Published app.", id: "text", type: "text-delta" },
            { id: "text", type: "text-end" },
            { delta: "Ready.", id: "next", type: "text-delta" },
          ]),
        returnValue: Promise.resolve(output),
      })
    );
    const response = await handleAppAgentMcpRequest(edit(), context);
    const body = await response.text();
    expect(body).toContain("Published app.");
    expect(body).toContain("Ready.");

    for (const privateValue of [
      "Private reasoning",
      "Large source code",
      "Large tool output",
      "Internal transcript",
      "internal-session",
      "inputTokens",
    ]) {
      expect(body).not.toContain(privateValue);
    }
  });
  it("rejects service and agent credentials and methods other than POST", async () => {
    const agentContext: Context = {
      ...context,
      agentToken: {
        appId: fixture.app.id,
        cliTokenId: crypto.randomUUID(),
        exp: 123,
        iat: 1,
        jti: "grant",
        platformUrl: "https://platform.test/api/platform",
        projectId: fixture.project.id,
        scope: fixture.scope.scope,
        sub: "app-agent",
        token: "agent-token",
      },
    };

    const agentResponse = await handleAppAgentMcpRequest(
      request("list_apps"),
      agentContext
    );

    expect(agentResponse.status).toBe(403);

    const response1 = await handleAppAgentMcpRequest(request("list_apps"), {
      ...context,
      runtimeService: true,
    });

    expect(response1.status).toBe(403);

    const response = await handleAppAgentMcpRequest(
      new Request("https://platform.test/api/platform/app-agent/mcp"),
      context
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
  it.each([
    { scopes: {} },
    { subjectId: null },
    { subjectId: "" },
    { subjectId: 123 },
    { subjectId: "x".repeat(257) },
    { scopes: { org: {} } },
    { schema: {} },
    { hostUrl: "https://user:password@host.test" },
  ])("rejects malformed asserted identity %j", async (invalid) => {
    const response2 = await handleAppAgentMcpRequest(
      request("list_apps", {}, invalid),
      context
    );

    expect(response2.status).toBe(400);
    expect(start).not.toHaveBeenCalled();
  });
  it.each(["", "not+base64", "eyJ9=", "x".repeat(8193), "_w"])(
    "rejects invalid context encoding %#",
    async (encoded) => {
      const response3 = await handleAppAgentMcpRequest(
        request("list_apps", {}, {}, { "x-patchsmith-context": encoded }),
        context
      );

      expect(response3.status).toBe(400);
    }
  );
  it("rejects cross-origin requests and extra authorization in tool arguments", async () => {
    const response4 = await handleAppAgentMcpRequest(
      request("list_apps", {}, {}, { origin: "https://other.test" }),
      context
    );

    expect(response4.status).toBe(403);

    const response = await handleAppAgentMcpRequest(
      edit({ subjectId: "other-user" }),
      context
    );

    expect(await response.text()).toContain('"isError":true');
    expect(start).not.toHaveBeenCalled();
  });
});
