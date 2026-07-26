/** Default executable filename for the host. Explicit --out paths stay
 * exact; only scriptc's generated default needs the Windows PE suffix. */
export function defaultExecutableName(stem: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `${stem}.exe` : stem;
}
