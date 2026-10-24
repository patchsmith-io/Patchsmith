import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { expect, it } from "vite-plus/test";

import { createPlatformFixture } from "#test/platform";
import { testServices } from "#test/services";

import type { Context } from "./context";

const { handleAppAgentMcpRequest } = await import("./app-agent-mcp");

it("connects an ordinary MCP client directly to the platform with standard headers", async () => {
  const fixture = await createPlatformFixture();
  const services = testServices({ database: fixture.db });
  const url = "https://platform.test/api/platform/app-agent/mcp";

  const headers = {
    authorization: "Bearer host-key",
    "x-patchsmith-context": Buffer.from(
      JSON.stringify({
        hostUrl: "https://host.test/api/patchsmith",
        scopes: { org: { tenant: "墨尔本" } },
        subjectId: "user",
      }),
      "utf-8"
    ).toString("base64url"),
  };

  const client = new Client(
    { name: "integration", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } }
  );

  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        fetch: async (input, init) => {
          const request = new Request(input, init);
          expect(request.url).toBe(
            "https://platform.test/api/platform/app-agent/mcp"
          );
          expect(request.headers.get("authorization")).toBe("Bearer host-key");
          // SAFETY: This test supplies the context members read by the handler; unrelated request context services are outside this scenario.

          return await handleAppAgentMcpRequest(
            request,
            /* oxlint-disable typescript/no-unsafe-type-assertion -- This test supplies the context members read by the handler; unrelated request context services are outside this scenario. */
            {
              ...services,
              organization: fixture.organization,
              project: fixture.project,
            } as Context
            /* oxlint-enable typescript/no-unsafe-type-assertion */
          );
        },
        requestInit: { headers },
      })
    );
    expect(client.getProtocolEra()).toBe("modern");
    const awaitedResult1 = await client.listTools();
    expect(awaitedResult1.tools.map(({ name }) => name)).toEqual([
      "list_apps",
      "create_app",
      "edit_app",
    ]);

    const awaitedResult2 = await client.callTool({
      arguments: {},
      name: "list_apps",
    });

    expect(awaitedResult2.isError).not.toBe(true);
    expect(awaitedResult2.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "text" })])
    );
    // Its tenant differs from the asserted Unicode tenant, so the real router must hide it.
    expect(JSON.stringify(awaitedResult2)).not.toContain(fixture.app.shortId);
  } finally {
    await client.close();
    await fixture.client.close();
  }
});
