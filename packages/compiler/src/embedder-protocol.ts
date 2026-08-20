import { IR_VERSION } from "./ir/nodes.js";

/**
 * What an embedder and this compiler must agree about before either trusts
 * the other's values.
 *
 * The problem it solves is narrow and real. An embedder imports this
 * compiler's distribution at runtime, because the compiler is a submodule
 * that has to be built and a clean checkout must still typecheck. Until now
 * the only check was that the expected functions EXIST — so a distribution
 * built from an incompatible revision passed, and failed later with a
 * structurally wrong plan, at a distance from the mismatch that caused it.
 *
 * Every version here is one an embedder actually depends on. There is no
 * range negotiation and no compatibility window: before 1.0 an exact
 * disagreement is a disagreement, and a compiler that guessed which
 * differences were survivable would be making the embedder's decision for it.
 *
 * This module imports nothing but a constant and runs no side effects, so
 * asking for the protocol can never be what breaks a build.
 */
export interface EmbedderProtocol {
  readonly protocol: "scriptc.embedder";
  /** The shape of THIS object. Changing it changes how a mismatch is even
   * reported, so it is checked before anything inside is read. */
  readonly protocolVersion: 1;
  /** Native IR carried inside a compilation plan. */
  readonly irVersion: number;
  readonly executablePlanVersion: 1;
  readonly libraryPlanVersion: 1;
  /** The driver-command plan both product planners hand back. */
  readonly externalCcPlanVersion: 1;
}

export function getEmbedderProtocol(): EmbedderProtocol {
  return Object.freeze({
    protocol: "scriptc.embedder",
    protocolVersion: 1,
    irVersion: IR_VERSION,
    executablePlanVersion: 1,
    libraryPlanVersion: 1,
    externalCcPlanVersion: 1,
  });
}
