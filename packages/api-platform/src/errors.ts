import { ORPCError } from "@orpc/server";
import type { ORPCErrorCode } from "@orpc/server";
import { Data } from "effect";

/** An SDK or infrastructure failure; cause stays server-side at the HTTP boundary. */
export class PlatformDependencyError extends Data.TaggedError(
  "PlatformDependencyError"
)<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export type PlatformFailure =
  | PlatformDependencyError
  | ORPCError<ORPCErrorCode, unknown>;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- JavaScript SDKs may reject with any value.
export const platformError = (cause: unknown): PlatformFailure => {
  if (cause instanceof ORPCError || cause instanceof PlatformDependencyError) {
    return cause;
  }

  return new PlatformDependencyError({
    cause,
    message:
      cause instanceof Error ? cause.message : "Platform dependency failed",
  });
};
