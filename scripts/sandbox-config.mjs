import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const example = "vcr.vercel.com/<team>/<project>/<repository>:<tag>";
const localEnv = fileURLToPath(new URL("../.env.local", import.meta.url));
let loadedLocalEnv = false;

function loadLocalEnv() {
  if (loadedLocalEnv) return;
  loadedLocalEnv = true;
  try {
    // Node preserves variables already present in the process environment,
    // allowing an agent or shell to override values from this local file.
    loadEnvFile(localEnv);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function sandboxImageConfig() {
  loadLocalEnv();
  // Keep tenancy explicit: a public clone must use a Vercel project its
  // operator owns rather than inheriting a maintainer's scope or project.
  const reference = process.env.SCRIPTC_SANDBOX_IMAGE;
  if (!reference) {
    throw new Error(`SCRIPTC_SANDBOX_IMAGE is required (for example: ${example})`);
  }

  const match = /^vcr\.vercel\.com\/([^/]+)\/([^/]+)\/([^/:]+):([^/:]+)$/.exec(reference);
  if (!match) {
    throw new Error(`SCRIPTC_SANDBOX_IMAGE must be a fully qualified VCR image (${example})`);
  }

  const [, team, project, repository, tag] = match;
  return {
    reference,
    team,
    project,
    repository,
    tag,
    sandboxImage: `${repository}:${tag}`,
  };
}
