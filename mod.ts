import type { MetaHeadTag, SiteConfig, StenoPlugin } from "@steno/steno";

/** Options accepted by this plugin. */
export interface PluginCspOptions {
  /**
   * How the policy is delivered. `"meta"` (default) injects a
   * `<meta http-equiv="Content-Security-Policy">` tag into `config.head`.
   * `"header"` writes a Netlify/Cloudflare-Pages-style `_headers` file to
   * the build output root in `afterBuild` (see the README for exactly
   * which hosts that format works on).
   */
  mode?: "meta" | "header";
  /**
   * Starting directive set, before contributions from other plugins (see
   * `config.globals.__cspContributions`) and `extraSources` are merged in.
   *
   * Defaults to `{ "default-src": ["'self'"], "style-src": ["'self'",
   * "'unsafe-inline'"] }`.
   */
  baseDirectives?: Record<string, string[]>;
  /**
   * Site-specific additions per directive, merged in after contributions
   * from other plugins.
   */
  extraSources?: Record<string, string[]>;
  /**
   * Emits `Content-Security-Policy-Report-Only` instead of the enforcing
   * `Content-Security-Policy` header/meta tag, for staged rollout.
   */
  reportOnly?: boolean;
  /**
   * When set, appends a `report-uri <uri>; report-to default` directive
   * pair to the policy.
   */
  reportUri?: string;
}

/** Default directive set before contributions/extras are merged in. */
export const DEFAULT_BASE_DIRECTIVES: Record<string, string[]> = {
  "default-src": ["'self'"],
  "style-src": ["'self'", "'unsafe-inline'"],
};

/**
 * The shared data-contract slot other plugins use to contribute CSP
 * sources, keyed by directive name. Populated by pushing into
 * `config.globals.__cspContributions` during a contributing plugin's own
 * `beforeBuild` (see the README's "Cross-plugin contract" section). Absent
 * when no contributing plugin ran.
 */
export type CspContributions = Record<string, string[]>;

/**
 * Merges any number of per-directive source maps into one, preserving
 * first-seen order within each directive and de-duplicating repeated
 * source tokens across all inputs. Later maps are merged in after earlier
 * ones but do not remove sources contributed earlier. `undefined` inputs
 * are skipped, so callers can pass an absent contributions slot directly.
 */
export function mergeDirectives(
  ...sources: Array<Record<string, string[]> | undefined>
): Record<string, string[]> {
  const merged: Record<string, string[]> = {};
  for (const source of sources) {
    if (!source) continue;
    for (const [directive, values] of Object.entries(source)) {
      const existing = merged[directive] ?? (merged[directive] = []);
      for (const value of values) {
        if (!existing.includes(value)) existing.push(value);
      }
    }
  }
  return merged;
}

/**
 * Builds the final `Content-Security-Policy` value from a merged directive
 * map. Directives are emitted in sorted (alphabetical) order for
 * deterministic output regardless of insertion order. Pure function, no
 * `SiteConfig` needed, so it's directly unit-testable.
 */
export function buildPolicy(
  directives: Record<string, string[]>,
  options: { reportUri?: string } = {},
): string {
  const directiveNames = Object.keys(directives).sort();
  const parts = directiveNames
    .filter((name) => directives[name].length > 0)
    .map((name) => `${name} ${directives[name].join(" ")}`);

  if (options.reportUri) {
    parts.push(`report-uri ${options.reportUri}`);
    parts.push("report-to default");
  }

  return parts.join("; ");
}

/**
 * Reads CSP source contributions pushed by an earlier-run plugin into
 * `config.globals.__cspContributions`, per the cross-plugin contract. Read
 * defensively -- the slot may be absent if no contributing plugin ran, or
 * if `plugin-csp` is declared before the contributing plugin in the site's
 * `plugins:` list (a config mistake this plugin can't detect on its own).
 */
export function readCspContributions(config: SiteConfig): CspContributions | undefined {
  const globals = config.globals as Record<string, unknown> | undefined;
  const contributions = globals?.__cspContributions;
  if (!contributions || typeof contributions !== "object") return undefined;
  return contributions as CspContributions;
}

/**
 * Creates the plugin-csp plugin.
 *
 * Must be declared **after** any plugin that contributes CSP sources (e.g.
 * `plugin-analytics`) in a site's `plugins:` list, since contributions are
 * read from `config.globals.__cspContributions` during this plugin's own
 * `beforeBuild`.
 *
 * ```yaml
 * plugins:
 *   - package: file:///path/to/plugin-analytics/mod.ts   # contributes CSP sources
 *   - package: file:///path/to/plugin-csp/mod.ts         # must run after
 *     options:
 *       mode: meta
 * ```
 */
export default function pluginCsp(options: PluginCspOptions = {}): StenoPlugin {
  const mode = options.mode ?? "meta";
  const baseDirectives = options.baseDirectives ?? DEFAULT_BASE_DIRECTIVES;
  const extraSources = options.extraSources ?? {};
  const reportOnly = options.reportOnly ?? false;
  const reportUri = options.reportUri;
  const headerName = reportOnly ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy";

  // Computed in beforeBuild, consumed by afterBuild when mode is "header".
  let policy = "";

  return {
    name: "plugin-csp",

    beforeBuild(config) {
      const contributions = readCspContributions(config);
      const merged = mergeDirectives(baseDirectives, contributions, extraSources);
      policy = buildPolicy(merged, { reportUri });

      if (mode === "meta") {
        const head = config.head ?? (config.head = []);
        const metaTag: MetaHeadTag = {
          tag: "meta",
          httpEquiv: headerName,
          content: policy,
          key: "csp",
        };
        head.push(metaTag);
      }
    },

    async afterBuild(config) {
      if (mode !== "header") return;

      if (!config.output) {
        throw new Error("plugin-csp: config.output is missing, cannot write _headers.");
      }

      const contents = `/*\n  ${headerName}: ${policy}\n`;
      await Deno.writeTextFile(`${config.output}/_headers`, contents);
    },
  };
}
