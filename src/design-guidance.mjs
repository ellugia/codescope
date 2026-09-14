import policyDocument from "../config/design-policy.json" with { type: "json" };

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
  return value;
}

const policy = freezeDeep(policyDocument);
const themes = Object.freeze(Object.keys(policy.themes));

export const DESIGN_GUIDANCE_VERSION = policy.version;
export const DESIGN_GUIDANCE_THEMES = themes;

export function getDesignGuidance(theme = "general") {
  if (typeof theme !== "string" || !themes.includes(theme)) {
    throw new RangeError("Unknown design guidance theme.");
  }

  const selected = policy.themes[theme];
  return Object.freeze({
    theme,
    version: policy.version,
    provenance: policy.provenance,
    summary: selected.summary,
    guidance: selected.guidance,
    guardrails: policy.guardrails,
  });
}
