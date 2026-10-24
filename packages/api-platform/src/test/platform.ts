import { app } from "@patchsmith/db/schema/apps";
import { organization } from "@patchsmith/db/schema/auth";
import { project } from "@patchsmith/db/schema/project";

import { canonicalizeScope } from "#scope";
import { createTestDb } from "#test/pglite";

export const createPlatformFixture = async () => {
  const database = await createTestDb();

  const [team] = await database.db
    .insert(organization)
    .values({
      createdAt: new Date(),
      name: "Test team",
      shortId: "team00000001",
      slug: "test-team",
    })
    .returning();

  if (!team) {
    throw new Error("Missing test team");
  }

  const [workspace] = await database.db
    .insert(project)
    .values({
      name: "Test project",
      organizationId: team.id,
      slug: "test-project",
    })
    .returning();

  if (!workspace) {
    throw new Error("Missing test project");
  }

  const scope = canonicalizeScope({ name: "org", value: { tenant: "one" } });

  const [installed] = await database.db
    .insert(app)
    .values({
      createdByAgent: true,
      name: "Calendar",
      projectId: workspace.id,
      shortId: "publicapp001",
      ...scope,
    })
    .returning();

  if (!installed) {
    throw new Error("Missing test app");
  }

  return {
    ...database,
    app: installed,
    organization: team,
    project: workspace,
    scope,
  };
};
