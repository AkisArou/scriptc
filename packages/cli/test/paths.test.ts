import { expect, test } from "vitest";
import { defaultExecutableName } from "../src/paths.js";

test("default executable names use the Windows PE suffix", () => {
  expect(defaultExecutableName("main", "win32")).toBe("main.exe");
  expect(defaultExecutableName("main", "linux")).toBe("main");
  expect(defaultExecutableName("main", "darwin")).toBe("main");
});
