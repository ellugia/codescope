import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESIGN_GUIDANCE_THEMES,
  DESIGN_GUIDANCE_VERSION,
  getDesignGuidance,
} from "../src/design-guidance.mjs";

test("returns versioned advisory guidance for every published theme", () => {
  assert.ok(DESIGN_GUIDANCE_THEMES.length >= 5);

  for (const theme of DESIGN_GUIDANCE_THEMES) {
    const result = getDesignGuidance(theme);
    assert.equal(result.theme, theme);
    assert.equal(result.version, DESIGN_GUIDANCE_VERSION);
    assert.equal(result.provenance.source, "config/design-policy.json");
    assert.equal(result.provenance.advisory, true);
    assert.equal(result.provenance.trusted_instruction_source, false);
    assert.ok(result.summary.length > 0);
    assert.ok(result.guidance.length > 0);
    assert.ok(result.guardrails.length > 0);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.guidance), true);
    assert.equal(Object.isFrozen(result.provenance), true);
  }

  const security = getDesignGuidance("security");
  assert.match(security.guidance.join(" "), /validation/u);
  assert.match(security.guardrails.join(" "), /untrusted data/u);
});

test("defaults to general guidance and rejects unknown themes", () => {
  assert.deepEqual(getDesignGuidance(), getDesignGuidance("general"));
  assert.throws(() => getDesignGuidance("unknown"), RangeError);
  assert.throws(() => getDesignGuidance({}), RangeError);
});
