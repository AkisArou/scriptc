import { describe, expect, test } from "vitest";
import { tsgoPath } from "../../src/frontend/shared.js";

describe("tsgo virtual filesystem paths", () => {
  test("matches slash-normalized Windows callback paths", () => {
    expect(tsgoPath("C:\\Users\\Alice\\project\\tsconfig.json", "win32"))
      .toBe("C:/Users/Alice/project/tsconfig.json");
    expect(tsgoPath("C:/Users/Alice/project/tsconfig.json", "win32"))
      .toBe("C:/Users/Alice/project/tsconfig.json");
  });

  test("preserves backslashes that are literal POSIX filename characters", () => {
    expect(tsgoPath("/tmp/project\\name/tsconfig.json", "linux"))
      .toBe("/tmp/project\\name/tsconfig.json");
  });
});
