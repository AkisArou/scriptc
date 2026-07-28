/**
 * Choose where tests that exercise the native host toolchain run.
 *
 * Darwin and Linux have supported native clang paths, so those files should
 * test the contributor's actual host. Other hosts keep the coverage in the
 * Linux Sandboxes. Darwin alone adds the compact kqueue/Mach-O contracts.
 */
export function sandboxHostSchedule(platform, invariantFiles) {
  const runsNative = platform === "darwin" || platform === "linux";
  return {
    darwinContracts: platform === "darwin",
    localArtifactContracts: runsNative,
    localInvariantFiles: runsNative ? invariantFiles : [],
    remoteArtifactContracts: !runsNative,
    remoteInvariantFiles: runsNative ? [] : invariantFiles,
  };
}

/**
 * Pin lane identity even when the parent shell, .env.local, or Sandbox image
 * already defines SCRIPTC_SAN. Tests enable sanitizers only for the exact
 * string "1", so an empty value explicitly restores the plain lane.
 */
export function sandboxLaneEnv(lane) {
  return {
    CI: "1",
    SCRIPTC_SAN: lane === "san" ? "1" : "",
  };
}
