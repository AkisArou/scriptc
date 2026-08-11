import { tmpdir } from "node:os";
import { buildTargetPlatform } from "@scriptc/compiler";

/** Default executable filename for the build target. Explicit --out paths
 * stay exact; only scriptc's generated default needs the Windows PE suffix. */
export function defaultExecutableName(stem: string, platform: string = buildTargetPlatform()): string {
  if (platform === "win32") return `${stem}.exe`;
  if (platform === "wasi") return `${stem}.wasm`;
  return stem;
}

/** Host paths exposed by `scriptc run` to a WASI Preview 1 module. Guest
 * `/tmp` maps to the host's real platform temp directory instead of assuming
 * the POSIX spelling exists (notably false on Windows). */
export function wasiPreopens(
  cwd: string = process.cwd(),
  hostTmp: string = tmpdir(),
): Record<string, string> {
  return { "/": cwd, "/tmp": hostTmp };
}
