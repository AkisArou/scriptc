import { buildTargetPlatform } from "@scriptc/compiler";
import { expect, test } from "vitest";
import { defaultExecutableName } from "../src/paths.js";

test("default executable names use the Windows PE suffix", () => {
  expect(defaultExecutableName("main", "win32")).toBe("main.exe");
  expect(defaultExecutableName("main", "linux")).toBe("main");
  expect(defaultExecutableName("main", "darwin")).toBe("main");
  expect(defaultExecutableName("main", "wasi")).toBe("main.wasm");
});

test("WASI cross-builds use the WebAssembly suffix", () => {
  const platform = buildTargetPlatform({
    SCRIPTC_CC: "zigcc",
    SCRIPTC_TARGET: "wasm32-wasi",
  });
  expect(platform).toBe("wasi");
  expect(defaultExecutableName("main", platform)).toBe("main.wasm");
});

test("Windows cross-builds use the PE suffix on a non-Windows host", () => {
  const platform = buildTargetPlatform({
    SCRIPTC_CC: "zigcc",
    SCRIPTC_TARGET: "x86_64-windows-gnu",
  });
  expect(platform).toBe("win32");
  expect(defaultExecutableName("main", platform)).toBe("main.exe");
});
