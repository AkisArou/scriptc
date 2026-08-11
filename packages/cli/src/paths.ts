import { buildTargetPlatform } from "@scriptc/compiler";

/** Default executable filename for the build target. Explicit --out paths
 * stay exact; only scriptc's generated default needs the Windows PE suffix. */
export function defaultExecutableName(stem: string, platform: string = buildTargetPlatform()): string {
  if (platform === "win32") return `${stem}.exe`;
  if (platform === "wasi") return `${stem}.wasm`;
  return stem;
}
