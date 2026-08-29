import { assertEquals, assertRejects } from "@std/assert";
import type { SiteConfig } from "@steno/steno";
import createPlugin, {
  buildPolicy,
  DEFAULT_BASE_DIRECTIVES,
  mergeDirectives,
  readCspContributions,
} from "./mod.ts";

function siteConfig(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    title: "Test site",
    description: "",
    author: "",
    output: "",
    ...overrides,
  };
}

Deno.test("plugin-csp: has a stable name", () => {
  const plugin = createPlugin();
  assertEquals(plugin.name, "plugin-csp");
});

Deno.test("plugin-csp: transformHtml is not implemented, no such hook", () => {
  const plugin = createPlugin();
  assertEquals(plugin.transformHtml, undefined);
});

// --- buildPolicy -------------------------------------------------------

Deno.test("buildPolicy: base directives alone", () => {
  const policy = buildPolicy(DEFAULT_BASE_DIRECTIVES);
  assertEquals(policy, "default-src 'self'; style-src 'self' 'unsafe-inline'");
});

Deno.test("buildPolicy: sorts directives alphabetically for deterministic output", () => {
  const policy = buildPolicy({
    "style-src": ["'self'"],
    "default-src": ["'self'"],
    "connect-src": ["'self'"],
  });
  assertEquals(
    policy,
    "connect-src 'self'; default-src 'self'; style-src 'self'",
  );
});

Deno.test("buildPolicy: omits directives with no sources", () => {
  const policy = buildPolicy({ "default-src": ["'self'"], "script-src": [] });
  assertEquals(policy, "default-src 'self'");
});

Deno.test("buildPolicy: appends report-uri and report-to when reportUri is set", () => {
  const policy = buildPolicy(
    { "default-src": ["'self'"] },
    { reportUri: "https://example.com/csp-report" },
  );
  assertEquals(
    policy,
    "default-src 'self'; report-uri https://example.com/csp-report; report-to default",
  );
});

Deno.test("buildPolicy: no report-uri directive when reportUri is unset", () => {
  const policy = buildPolicy({ "default-src": ["'self'"] });
  assertEquals(policy.includes("report-uri"), false);
});

// --- mergeDirectives -----------------------------------------------------

Deno.test("mergeDirectives: merges disjoint directives from multiple sources", () => {
  const merged = mergeDirectives(
    { "default-src": ["'self'"] },
    { "script-src": ["https://example.com"] },
  );
  assertEquals(merged, {
    "default-src": ["'self'"],
    "script-src": ["https://example.com"],
  });
});

Deno.test("mergeDirectives: dedupes repeated sources across inputs for the same directive", () => {
  const merged = mergeDirectives(
    { "script-src": ["'self'", "https://a.example"] },
    { "script-src": ["https://a.example", "https://b.example"] },
    { "script-src": ["https://b.example"] },
  );
  assertEquals(merged["script-src"], [
    "'self'",
    "https://a.example",
    "https://b.example",
  ]);
});

Deno.test("mergeDirectives: skips undefined sources (absent contributions)", () => {
  const merged = mergeDirectives({ "default-src": ["'self'"] }, undefined, {
    "script-src": ["x"],
  });
  assertEquals(merged, { "default-src": ["'self'"], "script-src": ["x"] });
});

// --- readCspContributions ------------------------------------------------

Deno.test("readCspContributions: reads the shared contract slot from config.globals", () => {
  const config = siteConfig({
    globals: {
      __cspContributions: { "script-src": ["https://analytics.example"] },
    },
  });
  assertEquals(readCspContributions(config), {
    "script-src": ["https://analytics.example"],
  });
});

Deno.test("readCspContributions: returns undefined when no contributor ran", () => {
  assertEquals(readCspContributions(siteConfig()), undefined);
  assertEquals(readCspContributions(siteConfig({ globals: {} })), undefined);
});

// --- plugin: beforeBuild merging ------------------------------------------

Deno.test("plugin-csp: beforeBuild merges base + contributions + extraSources, deduped", async () => {
  const plugin = createPlugin({
    extraSources: { "script-src": ["https://widget.example", "'self'"] },
  });
  const config = siteConfig({
    globals: {
      __cspContributions: {
        "script-src": ["https://analytics.example", "'self'"],
        "connect-src": ["https://analytics.example"],
      },
    },
  });
  await plugin.beforeBuild?.(config);

  const meta = config.head?.find((tag) => "key" in tag && tag.key === "csp");
  assertEquals(meta?.tag, "meta");
  const content = (meta as { content?: string }).content ?? "";

  // default-src / style-src from base defaults
  assertEquals(content.includes("default-src 'self'"), true);
  assertEquals(content.includes("style-src 'self' 'unsafe-inline'"), true);
  // connect-src contributed by another plugin
  assertEquals(content.includes("connect-src https://analytics.example"), true);
  // script-src merged from contribution + extraSources, 'self' deduped to one occurrence
  const scriptSrcMatch = content.match(/script-src ([^;]+)/);
  assertEquals(
    scriptSrcMatch?.[1],
    "https://analytics.example 'self' https://widget.example",
  );
});

Deno.test("plugin-csp: mode 'meta' injects a MetaHeadTag with http-equiv Content-Security-Policy", async () => {
  const plugin = createPlugin({ mode: "meta" });
  const config = siteConfig();
  await plugin.beforeBuild?.(config);

  assertEquals(config.head?.length, 1);
  const tag = config.head?.[0] as {
    tag?: string;
    httpEquiv?: string;
    content?: string;
    key?: string;
  };
  assertEquals(tag.tag, "meta");
  assertEquals(tag.httpEquiv, "Content-Security-Policy");
  assertEquals(tag.key, "csp");
  assertEquals(
    tag.content,
    "default-src 'self'; style-src 'self' 'unsafe-inline'",
  );
});

Deno.test("plugin-csp: reportOnly swaps the meta tag's http-equiv", async () => {
  const plugin = createPlugin({ reportOnly: true });
  const config = siteConfig();
  await plugin.beforeBuild?.(config);

  const tag = config.head?.[0] as { httpEquiv?: string };
  assertEquals(tag.httpEquiv, "Content-Security-Policy-Report-Only");
});

Deno.test("plugin-csp: mode 'meta' preserves existing config.head entries", async () => {
  const plugin = createPlugin();
  const config = siteConfig({
    head: [{ tag: "link", rel: "icon", href: "/favicon.ico" }],
  });
  await plugin.beforeBuild?.(config);

  assertEquals(config.head?.length, 2);
  assertEquals(config.head?.[0].tag, "link");
});

// --- plugin: mode "header" ------------------------------------------------

Deno.test("plugin-csp: mode 'header' writes _headers to <output>/_headers in afterBuild", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const plugin = createPlugin({ mode: "header" });
    const config = siteConfig({ output: dir });
    await plugin.beforeBuild?.(config);
    // mode "header" must not touch config.head
    assertEquals(config.head, undefined);

    await plugin.afterBuild?.(config);

    const contents = await Deno.readTextFile(`${dir}/_headers`);
    assertEquals(
      contents,
      "/*\n  Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'\n",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("plugin-csp: mode 'header' + reportOnly writes the Report-Only header name", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const plugin = createPlugin({ mode: "header", reportOnly: true });
    const config = siteConfig({ output: dir });
    await plugin.beforeBuild?.(config);
    await plugin.afterBuild?.(config);

    const contents = await Deno.readTextFile(`${dir}/_headers`);
    assertEquals(
      contents.includes("Content-Security-Policy-Report-Only:"),
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("plugin-csp: mode 'meta' afterBuild is a no-op (no _headers written)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const plugin = createPlugin({ mode: "meta" });
    const config = siteConfig({ output: dir });
    await plugin.beforeBuild?.(config);
    await plugin.afterBuild?.(config);

    await assertRejects(() => Deno.readTextFile(`${dir}/_headers`));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("plugin-csp: mode 'header' rejects when config.output is missing", async () => {
  const plugin = createPlugin({ mode: "header" });
  const config = siteConfig({ output: undefined });
  await plugin.beforeBuild?.(config);
  await assertRejects(() => plugin.afterBuild?.(config) as Promise<void>);
});
