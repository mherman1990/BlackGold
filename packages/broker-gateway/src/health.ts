export const GATEWAY_VERSION = "0.1.0";

export type GatewayHealth = {
  ok: true;
  role: "gateway";
  /** False by construction in Phase 0: no live adapter, no authorization verifier, no credential loader. */
  liveCapable: false;
  credentialLoaded: false;
  adapters: ["synthetic"];
};

export function health(): GatewayHealth {
  return { ok: true, role: "gateway", liveCapable: false, credentialLoaded: false, adapters: ["synthetic"] };
}
