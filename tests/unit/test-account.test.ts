import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/server/errors";
import { loginTestUser, requireTestUser, TEST_USER_ID } from "@/lib/services/test-account";

const env = { TEST_API_USERNAME: "evaluator", TEST_API_PASSWORD: "s3cret-password" };
const expectedToken = createHash("sha256")
  .update("olympus-test:evaluator:s3cret-password")
  .digest("hex");

async function caught(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error("expected an ApiError");
}

const withAuth = (value?: string) =>
  new Request("http://localhost/api/v1/profile", {
    headers: value === undefined ? {} : { authorization: value },
  });

describe("loginTestUser", () => {
  it("returns a deterministic Bearer token for the configured account", async () => {
    const login = await loginTestUser(env, "evaluator", "s3cret-password");
    expect(login).toEqual({
      accessToken: expectedToken,
      tokenType: "Bearer",
      role: "test_user",
      userId: TEST_USER_ID,
    });
    expect((await loginTestUser(env, "evaluator", "s3cret-password")).accessToken).toBe(
      expectedToken,
    );
  });

  it("defaults the username to test_user", async () => {
    const login = await loginTestUser(
      { TEST_API_USERNAME: "", TEST_API_PASSWORD: "p" },
      "test_user",
      "p",
    );
    expect(login.userId).toBe("test:evaluator");
  });

  it.each([
    ["evaluator", "wrong"],
    ["someone", "s3cret-password"],
    ["", ""],
  ])("rejects %s / %s with 401", async (username, password) => {
    expect(await caught(loginTestUser(env, username, password))).toMatchObject({
      status: 401,
      code: "INVALID_CREDENTIALS",
    });
  });

  it("answers 503 when the account is not configured", async () => {
    expect(
      await caught(
        loginTestUser({ TEST_API_USERNAME: "", TEST_API_PASSWORD: "" }, "test_user", ""),
      ),
    ).toMatchObject({ status: 503, code: "TEST_ACCOUNT_NOT_CONFIGURED" });
  });
});

describe("requireTestUser", () => {
  it("accepts the account token", async () => {
    expect(await requireTestUser(env, withAuth(`Bearer ${expectedToken}`))).toEqual({
      userId: TEST_USER_ID,
      admin: false,
    });
  });

  it.each([[undefined], ["Basic abc"], ["Bearer"], [`Bearer ${"0".repeat(64)}`]])(
    "rejects Authorization %j with 401",
    async (header) => {
      expect(await caught(requireTestUser(env, withAuth(header)))).toMatchObject({
        status: 401,
        code: "UNAUTHORIZED",
      });
    },
  );

  it("invalidates old tokens when the password changes", async () => {
    const changed = { ...env, TEST_API_PASSWORD: "new-password" };
    expect(
      (await caught(requireTestUser(changed, withAuth(`Bearer ${expectedToken}`)))).status,
    ).toBe(401);
  });
});
