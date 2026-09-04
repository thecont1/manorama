/**
 * The Manorama `.vendo/` profile as a BUNDLED, in-memory compose-time input.
 *
 * Cloudflare Workers have no filesystem at request time, and Vendo's default
 * readers fail soft — a missing or unreadable file silently yields no rules,
 * no tools, no brief. This module imports each profile piece as a build-time
 * asset so the Worker bundle carries the profile verbatim, then asserts its
 * integrity loudly: a profile that arrives broken throws at import time
 * instead of composing an unguarded assistant.
 */
import { readFileSync } from "node:fs";
import type { ExtractedTool, OverridesFile } from "@vendoai/actions";
import type { PolicyFile, PolicyRule } from "@vendoai/guard";
import type { VendoTheme } from "@vendoai/apps/contract";
import type { CatalogFile } from "@vendoai/vendo/server";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

/** `.vendo/tools.json` — the machine layer `vendo sync` regenerates wholesale. */
const toolsFile = JSON.parse(read("../.vendo/tools.json")) as {
  tools?: ExtractedTool[];
};
/** `.vendo/overrides.json` — the only human-edited layer (risk grades, etc.). */
const overridesFile = JSON.parse(read("../.vendo/overrides.json")) as OverridesFile;
/** `.vendo/policy.json` — the authoritative guard policy document. */
const policyFile = JSON.parse(read("../.vendo/policy.json")) as PolicyFile;
/** `.vendo/theme.json` — the Manorama brand surface. */
const themeFile = JSON.parse(read("../.vendo/theme.json")) as VendoTheme;
/** `.vendo/catalog.json` — the named tool groups the console lists. */
const catalogFile = JSON.parse(read("../.vendo/catalog.json")) as CatalogFile;
/** `.vendo/brief.md` — the operator brief. */
const brief = read("../.vendo/brief.md");

/**
 * Apply the human-authored overrides (risk grades, titles, semantics) on top
 * of the generated tool descriptors, so the composed registry sees ONE list.
 */
const tools: ExtractedTool[] = (toolsFile.tools ?? []).map((tool) => {
  const override = overridesFile.tools?.[tool.name];
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

assertProfileIntegrity({ tools, policy: policyFile });

/** The single compose-time profile object `createVendo({ profile })` consumes. */
export const vendoProfile = {
  tools,
  overrides: overridesFile,
  theme: themeFile,
  brief,
  catalog: catalogFile,
  policy: policyFile,
} as const;
