import { call } from "@orpc/server";
import { organization } from "@patchsmith/db/schema/auth";
import { cliAuthSession, cliToken } from "@patchsmith/db/schema/cli-auth";
import { project as projectTable } from "@patchsmith/db/schema/project";
import { eq, sql } from "drizzle-orm";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import type { Context } from "#context";
import { env } from "#env";
import { createTestDb } from "#test/pglite";
import { testServices } from "#test/services";

const { cliAuthRouter } = await import("./cli-auth");

const organizationId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";

const scope = {
  name: "user",
  value: { organizationId: "org_123", userId: "user_456" },
};

const expectedScope = {
  name: "user",
  value: { organizationId: "org_123", userId: "user_456" },
};

const expectedScopeKey = "83f6cbb3372e91fda7451be1728a9e91";

let services: ReturnType<typeof testServices>;

const createContext = (): Context => ({
  ...services,
  organization: {
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    id: organizationId,
    logo: null,
    metadata: null,
    name: "Analytical Engines",
    shortId: "team00000001",
    slug: "analytical-engines",
  },
  project: {
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    id: projectId,
    name: "Compiler",
    organizationId,
    shortId: "proj00000001",
    slug: "compiler",
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  },
  storage: {
    createDownloadUrl: vi.fn(),
    createUploadUrl: vi.fn(),
    delete: vi.fn(),
    head: vi.fn(),
    type: "s3",
  },
});

describe("platform CLI auth scopes", () => {
  let client: Awaited<ReturnType<typeof createTestDb>>["client"];
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];

  beforeEach(async () => {
    if (
      !(
        env.AUTH_SECRET !== undefined &&
        env.AUTH_SECRET !== null &&
        env.AUTH_SECRET !== ""
      )
    ) {
      throw new Error(
        "The CLI auth test requires AUTH_SECRET in its Vitest config."
      );
    }

    const testDb = await createTestDb();
    ({ client } = testDb);
    ({ db } = testDb);
    services = testServices({ database: db });

    await db.insert(organization).values({
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      id: organizationId,
      name: "Analytical Engines",
      shortId: "team00000001",
      slug: "analytical-engines",
    });
    await db.insert(projectTable).values({
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
      id: projectId,
      name: "Compiler",
      organizationId,
      slug: "compiler",
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    });
  });

  afterEach(async () => {
    await client.close();
    vi.clearAllMocks();
  });

  it("stores and returns the exact structured scope when issuing a CLI token", async () => {
    const context = createContext();
    const started = await call(cliAuthRouter.start, { body: {} }, { context });
    await call(
      cliAuthRouter.approve,
      { body: { scope, userCode: started.body.userCode } },
      { context }
    );

    const polled = await call(
      cliAuthRouter.poll,
      { body: { deviceCode: started.body.deviceCode } },
      { context }
    );

    if (polled.body.status !== "approved") {
      throw new Error("Expected CLI auth session to be approved.");
    }

    const { deployToken, ...approvedSession } = polled.body;
    expect(approvedSession).toEqual({
      scope: expectedScope,
      status: "approved",
    });
    expect(deployToken).toBeTypeOf("string");

    const verified = await call(
      cliAuthRouter.verifyToken,
      { body: { deployToken: polled.body.deployToken } },
      { context }
    );

    expect(verified.body).toEqual({ scope: expectedScope });

    const token = await db.query.cliToken.findFirst();
    expect(token).toMatchObject({
      scope: expectedScope,
      scopeKey: expectedScopeKey,
    });
    expect(token?.lastUsedAt).toBeInstanceOf(Date);
  });

  it("rejects malformed stored scopes in approved sessions and deploy tokens", async () => {
    const context = createContext();
    const started = await call(cliAuthRouter.start, { body: {} }, { context });
    await call(
      cliAuthRouter.approve,
      { body: { scope, userCode: started.body.userCode } },
      { context }
    );
    const session = await db.query.cliAuthSession.findFirst();

    if (!session) {
      throw new Error("Expected CLI auth session.");
    }

    await db
      .update(cliAuthSession)
      .set({ scope: { name: "user", value: {} } })
      .where(eq(cliAuthSession.id, session.id));
    await expect(
      call(
        cliAuthRouter.poll,
        { body: { deviceCode: started.body.deviceCode } },
        { context }
      )
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await db
      .update(cliAuthSession)
      .set({ scope: expectedScope, scopeKey: "0".repeat(32) })
      .where(eq(cliAuthSession.id, session.id));
    await expect(
      call(
        cliAuthRouter.poll,
        { body: { deviceCode: started.body.deviceCode } },
        { context }
      )
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await db
      .update(cliAuthSession)
      .set({ scope: expectedScope, scopeKey: expectedScopeKey })
      .where(eq(cliAuthSession.id, session.id));

    const polled = await call(
      cliAuthRouter.poll,
      { body: { deviceCode: started.body.deviceCode } },
      { context }
    );

    if (polled.body.status !== "approved") {
      throw new Error("Expected approved CLI token.");
    }

    const token = await db.query.cliToken.findFirst();

    if (!token) {
      throw new Error("Expected CLI token.");
    }

    await db
      .update(cliToken)
      .set({ scope: { name: "user", value: {} } })
      .where(eq(cliToken.id, token.id));
    await expect(
      call(
        cliAuthRouter.verifyToken,
        { body: { deployToken: polled.body.deployToken } },
        { context }
      )
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    await db
      .update(cliToken)
      .set({ scope: expectedScope, scopeKey: "0".repeat(32) })
      .where(eq(cliToken.id, token.id));
    await expect(
      call(
        cliAuthRouter.verifyToken,
        { body: { deployToken: polled.body.deployToken } },
        { context }
      )
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
  it("reports pending, denied, and expired sessions without issuing credentials", async () => {
    const context = createContext();
    const started = await call(cliAuthRouter.start, { body: {} }, { context });
    const pollInput = { body: { deviceCode: started.body.deviceCode } };
    await expect(
      call(cliAuthRouter.poll, pollInput, { context })
    ).resolves.toEqual({ body: { status: "pending" } });
    await call(
      cliAuthRouter.deny,
      { body: { userCode: started.body.userCode } },
      { context }
    );
    await expect(
      call(cliAuthRouter.poll, pollInput, { context })
    ).resolves.toEqual({ body: { status: "denied" } });
    const session = await db.query.cliAuthSession.findFirst();

    if (!session) {
      throw new Error("Missing auth session");
    }

    await db
      .update(cliAuthSession)
      .set({ expiresAt: new Date(0) })
      .where(eq(cliAuthSession.id, session.id));
    await expect(
      call(cliAuthRouter.poll, pollInput, { context })
    ).resolves.toEqual({ body: { status: "expired" } });
    expect(await db.query.cliToken.findMany()).toEqual([]);
  });

  it("consumes an approved session only once across concurrent polls", async () => {
    const context = createContext();
    const started = await call(cliAuthRouter.start, { body: {} }, { context });
    await call(
      cliAuthRouter.approve,
      { body: { scope, userCode: started.body.userCode } },
      { context }
    );

    const poll = async () =>
      await call(
        cliAuthRouter.poll,
        { body: { deviceCode: started.body.deviceCode } },
        { context }
      );

    const results = await Promise.allSettled([poll(), poll()]);
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected")
    ).toMatchObject([{ reason: { code: "NOT_FOUND" } }]);
    expect(await db.query.cliToken.findMany()).toHaveLength(1);
    expect(await db.query.cliAuthSession.findMany()).toEqual([]);
  });

  it("rolls back session consumption when credential persistence fails", async () => {
    const context = createContext();
    const started = await call(cliAuthRouter.start, { body: {} }, { context });
    await call(
      cliAuthRouter.approve,
      { body: { scope, userCode: started.body.userCode } },
      { context }
    );
    await db.execute(
      sql`CREATE FUNCTION fail_cli_insert() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'Token persistence failed'; END $$ LANGUAGE plpgsql`
    );
    await db.execute(
      sql`CREATE TRIGGER fail_cli_insert BEFORE INSERT ON cli_token FOR EACH ROW EXECUTE FUNCTION fail_cli_insert()`
    );
    await expect(
      call(
        cliAuthRouter.poll,
        { body: { deviceCode: started.body.deviceCode } },
        { context }
      )
    ).rejects.toMatchObject({ _tag: "PlatformDependencyError" });
    expect(await db.query.cliAuthSession.findMany()).toEqual([
      expect.objectContaining({ status: "approved" }),
    ]);
    expect(await db.query.cliToken.findMany()).toEqual([]);
  });

  it("does not let another project approve or poll a session", async () => {
    const context = createContext();
    const started = await call(cliAuthRouter.start, { body: {} }, { context });

    const foreign = {
      ...context,
      project: { ...context.project, id: crypto.randomUUID() },
    };

    await expect(
      call(
        cliAuthRouter.approve,
        { body: { scope, userCode: started.body.userCode } },
        { context: foreign }
      )
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      call(
        cliAuthRouter.poll,
        { body: { deviceCode: started.body.deviceCode } },
        { context: foreign }
      )
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await db.query.cliToken.findMany()).toEqual([]);
  });
});
