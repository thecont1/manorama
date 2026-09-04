/**
 * The Manorama `.vendo/` profile as a BUNDLED, in-memory compose-time input.
 *
 * Cloudflare Workers have no filesystem at request time, and Vendo's default
 * readers fail soft — a missing or unreadable file silently yields no rules,
 * no tools, no brief. The profile pieces live in `profile.generated.ts` as
 * pure data literals (flattened from `.vendo/` by scripts/gen-vendo-profile.ts
 * after every `vendo sync`), so every bundler inlines them into the Worker.
 * This module then asserts the profile's integrity loudly: a profile that
 * arrives broken throws at import time instead of composing an unguarded
 * assistant.
 */
import type { ExtractedTool, OverridesFile } from "@vendoai/actions";
import type { PolicyFile, PolicyRule } from "@vendoai/guard";
import type { VendoTheme } from "@vendoai/apps/contract";
import type { CatalogFile } from "@vendoai/vendo/server";
import {
  BRIEF,
  CATALOG_FILE,
  OVERRIDES_FILE,
  POLICY_FILE,
  THEME_FILE,
  TOOLS_FILE,
} from "./profile.generated";

/**
 * Apply the human-authored overrides (risk grades, titles, semantics) on top
 * of the generated tool descriptors, so the composed registry sees ONE list.
 */
const tools: ExtractedTool[] = (TOOLS_FILE.tools ?? []).map((tool) => {
  const override = OVERRIDES_FILE.tools?.[tool.name];
  return override === undefined ? tool : { ...tool, ...override };
});

/** Fail-loud integrity gate — see `assertProfileIntegrity` for the contract. */
export function assertProfileIntegrity(profile: {
  tools: ExtractedTool[];
  policy?: { rules?: PolicyRule[] };
}): void {
  if (profile.tools.length === 0) {
    throw new Error(
      "vendo profile: tools layer is empty — the assistant would have no host capabilities. " +
      "Run `vendo sync` and rebuild.",
    );
  }
  const rules = profile.policy?.rules ?? [];
  if (rules.length === 0) {
    throw new Error(
      "vendo profile: policy.json carries no rules — the guard would run wide open. " +
      "Restore .vendo/policy.json and rebuild.",
    );
  }
  // The guard's rule evaluation is FIRST-match-wins: venue rules (mcp,
  // automation) must precede the risk-tier defaults or a leading read→run
  // rule short-circuits them.
  const firstRisk = rules.findIndex((rule) => "risk" in rule.match);
  const lastVenue = rules.reduce(
    (last, rule, i) => ("venue" in rule.match ? i : last),
    -1,
  );
  if (firstRisk !== -1 && lastVenue > firstRisk) {
    throw new Error(
      "vendo profile: venue rules must precede risk rules (guard is first-match-wins) — " +
      "a leading risk rule lets MCP/automation reads run silently.",
    );
  }
  if (!profile.tools.some((tool) => tool.risk !== undefined)) {
    throw new Error(
      "vendo profile: no tool carries a risk grade — overrides.json is missing or empty.",
    );
  }
}

assertProfileIntegrity({ tools, policy: POLICY_FILE });

/** The single compose-time profile object `createVendo({ profile })` consumes. */
export const vendoProfile = {
  tools,
  overrides: OVERRIDES_FILE,
  theme: THEME_FILE,
  brief: BRIEF,
  catalog: CATALOG_FILE,
  policy: POLICY_FILE,
} as const;
