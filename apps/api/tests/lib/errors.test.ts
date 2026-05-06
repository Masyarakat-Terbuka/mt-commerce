/**
 * Verifies that `issuesToDetails` produces the wire-stable shape used by both
 * the error handler (for raw `ZodError`) and routes that pre-validate.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { issuesToDetails } from "../../src/lib/errors.js";

describe("issuesToDetails", () => {
  it("projects ZodIssues to { issues: [{ path: string[], code, message }] }", () => {
    const result = z
      .object({ note: z.string().max(3) })
      .safeParse({ note: "too long" });
    if (result.success) throw new Error("expected validation failure");

    const details = issuesToDetails(result.error.issues);
    expect(details).toEqual({
      issues: [
        {
          path: ["note"],
          code: expect.any(String),
          message: expect.any(String),
        },
      ],
    });
    // Path is plain string array (no numbers, no symbols).
    expect(details.issues[0]?.path.every((p) => typeof p === "string")).toBe(
      true,
    );
  });

  it("stringifies numeric path segments (array indices)", () => {
    const result = z
      .array(z.string())
      .safeParse(["ok", 42]);
    if (result.success) throw new Error("expected validation failure");
    const details = issuesToDetails(result.error.issues);
    expect(details.issues[0]?.path).toEqual(["1"]);
  });
});
