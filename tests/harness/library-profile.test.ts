/* Library-mode profile loader/validator (stage 1 of the library emission mode):
 * every malformation family the design names is SC4001 with the offending
 * JSON path in the message; a well-formed profile round-trips into the
 * resolved LibraryProfile shape (entry made absolute against the profile's
 * own directory, teachings rider captured). */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { loadLibraryProfile, profileTeaching } from "@scriptc/compiler";

const dir = mkdtempSync(join(tmpdir(), "scriptc-lib-profile-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
function writeProfile(json: unknown): string {
  const p = join(dir, `p${n++}.json`);
  writeFileSync(p, typeof json === "string" ? json : JSON.stringify(json));
  return p;
}

const good = {
  profile_format: 1,
  name: "conformance-test",
  entry: "src/lib.ts",
  emission: "llvm",
  abi: {
    prefix: "kx_",
    init_symbol: "kx_init",
    sink_register_symbol: "kx_set_panic_sink",
    collect_symbol: "kx_collect",
    result_reset_symbol: null,
  },
  exports: [
    { export: "update", symbol: "kx_update", params: ["f64", "string"], returns: "bytes" },
    { export: "score", symbol: "kx_score", params: ["u32", "bool"], returns: "f64" },
  ],
};

function expectSc4001(json: unknown, fragment: string): void {
  const r = loadLibraryProfile(writeProfile(json));
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.diagnostics).toHaveLength(1);
  expect(r.diagnostics[0]!.code).toBe("SC4001");
  expect(r.diagnostics[0]!.message).toContain(fragment);
}

describe("library profile validation", () => {
  test("well-formed profile resolves", () => {
    const path = writeProfile(good);
    const r = loadLibraryProfile(path);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profile.name).toBe("conformance-test");
    expect(r.profile.emission).toBe("llvm");
    expect(r.profile.prefix).toBe("kx_");
    expect(r.profile.initSymbol).toBe("kx_init");
    expect(r.profile.collectSymbol).toBe("kx_collect");
    expect(r.profile.resultResetSymbol).toBeNull();
    // entry resolves against the profile file's directory
    expect(r.profile.entry).toBe(join(dir, "src/lib.ts"));
    expect(r.profile.exports).toHaveLength(2);
    expect(r.profile.exports[1]!.params).toEqual(["u32", "bool"]);
  });

  test("teachings rider: per-code key wins, 'async' is the shared fallback", () => {
    const r = loadLibraryProfile(
      writeProfile({
        ...good,
        determinism: { teachings: { async: "use kx_schedule instead", SC4004: "wrap it in a sync facade" } },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(profileTeaching(r.profile, "SC4004")).toBe("wrap it in a sync facade");
    expect(profileTeaching(r.profile, "SC4005")).toBe("use kx_schedule instead");
    expect(profileTeaching(r.profile, "SC4001")).toBeUndefined();
  });

  test("parse error", () => expectSc4001("{ not json", "not valid JSON"));
  test("wrong format", () => expectSc4001({ ...good, profile_format: 2 }, "profile_format"));
  test("missing name", () => {
    const { name: _drop, ...rest } = good;
    expectSc4001(rest, "'name'");
  });
  test("bad emission", () => expectSc4001({ ...good, emission: "wasm" }, "emission"));
  test("bad prefix identifier", () =>
    expectSc4001({ ...good, abi: { ...good.abi, prefix: "9bad_" } }, "abi.prefix"));
  test("symbol without the prefix", () =>
    expectSc4001({ ...good, abi: { ...good.abi, init_symbol: "other_init" } }, "prefix"));
  test("symbol not a C identifier", () =>
    expectSc4001({ ...good, abi: { ...good.abi, init_symbol: "kx_init-now" } }, "C identifier"));
  test("unknown field inside abi", () =>
    expectSc4001({ ...good, abi: { ...good.abi, init: "kx_init" } }, "unknown field 'abi.init'"));
  test("unknown field inside an export entry", () =>
    expectSc4001(
      { ...good, exports: [{ ...good.exports[0], param: [] }] },
      "unknown field 'exports[0].param'",
    ));
  test("unknown top-level fields are reserved surface, ignored", () => {
    const r = loadLibraryProfile(writeProfile({ ...good, determinism: { deny: ["Math.random"] }, contract: {} }));
    expect(r.ok).toBe(true);
  });
  test("duplicate symbols", () =>
    expectSc4001(
      { ...good, exports: [{ export: "update", symbol: "kx_init", params: [], returns: "void" }] },
      "declared twice",
    ));
  test("duplicate export names", () =>
    expectSc4001(
      {
        ...good,
        exports: [
          { export: "update", symbol: "kx_a", params: [], returns: "void" },
          { export: "update", symbol: "kx_b", params: [], returns: "void" },
        ],
      },
      "mapped twice",
    ));
  test("unknown marshalling class", () =>
    expectSc4001(
      { ...good, exports: [{ export: "f", symbol: "kx_f", params: ["i64"], returns: "void" }] },
      "params[0]",
    ));
  test("integer classes are param-only in v1", () =>
    expectSc4001(
      { ...good, exports: [{ export: "f", symbol: "kx_f", params: [], returns: "u32" }] },
      "parameter-only in v1",
    ));
  test("void is return-only", () =>
    expectSc4001(
      { ...good, exports: [{ export: "f", symbol: "kx_f", params: ["void"], returns: "void" }] },
      "params[0]",
    ));
});

/* ── the ask-2 sidecar section ─────────────────────────────────────────── */

const goodSidecar = {
  wire_version: 3,
  abi_version: 1,
  snapshot_format: 1,
  build_id_symbol: "kx_build_id",
  abi_version_symbol: "kx_abi_version",
  model: "Model",
  msg: "Msg",
};

describe("library profile sidecar section", () => {
  test("well-formed sidecar section resolves with its defaults", () => {
    const r = loadLibraryProfile(writeProfile({ ...good, sidecar: goodSidecar }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profile.sidecar).toEqual({
      path: null,
      wireVersion: 3,
      abiVersion: 1,
      snapshotFormat: 1,
      buildIdSymbol: "kx_build_id",
      abiVersionSymbol: "kx_abi_version",
      model: "Model",
      msg: "Msg",
      initExport: "init",
      updateExport: "update",
      subscriptionsExport: "subscriptions",
      sourceHash: "module-graph",
    });
    // The profile's exact bytes ride along (build_id input 2).
    expect(r.profile.profileBytes.length).toBeGreaterThan(0);
  });

  test("no sidecar section means no sidecar config", () => {
    const r = loadLibraryProfile(writeProfile(good));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profile.sidecar).toBeNull();
  });

  test("unknown field inside sidecar refuses", () =>
    expectSc4001({ ...good, sidecar: { ...goodSidecar, extra: 1 } }, "sidecar.extra"));
  test("getter symbol without the prefix refuses", () =>
    expectSc4001({ ...good, sidecar: { ...goodSidecar, build_id_symbol: "zz_build_id" } }, "sidecar.build_id_symbol"));
  test("a getter symbol colliding with a mode symbol refuses", () =>
    expectSc4001({ ...good, sidecar: { ...goodSidecar, build_id_symbol: "kx_init" } }, "declared twice"));
  test("model and msg must differ", () =>
    expectSc4001({ ...good, sidecar: { ...goodSidecar, msg: "Model" } }, "differ"));
  test("an unknown source_hash contract refuses", () =>
    expectSc4001({ ...good, sidecar: { ...goodSidecar, source_hash: "sha256" } }, "module-graph"));
  test("a non-integer version constant refuses", () =>
    expectSc4001({ ...good, sidecar: { ...goodSidecar, wire_version: 1.5 } }, "sidecar.wire_version"));
  test("an absolute sidecar path refuses", () =>
    expectSc4001({ ...good, sidecar: { ...goodSidecar, path: "/tmp/contract.json" } }, "sidecar.path"));
});
