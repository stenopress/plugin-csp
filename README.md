# @steno/plugin-csp

Content-Security-Policy plugin for [Steno](https://github.com/steno/steno) that generates a `Content-Security-Policy`
header or meta tag from declarative config -- config a site author edits directly, plus structured
input from other plugins (analytics, comments, embeds) contributing the sources they each need (
instead of a domain table copy-pasted by hand into multiple templates.)

This is for a site that wants a real CSP without hand-maintaining a directive string, and without
every script-injecting plugin needing to also duplicate that string's domain list.

## Installation

```yaml
# content/.steno/config.yml
plugins:
  - jsr:@steno/plugin-csp
```

**Plugin order matters.** Steno runs plugins in the order they're declared, and this plugin's
`beforeBuild` reads a slot other plugins write to during _their own_ `beforeBuild` -- see "Cross-plugin
contract" below. Declare `@steno/plugin-csp` **after** any plugin that wants to contribute CSP
sources (an analytics plugin, a comments or Fediverse-embed plugin), or its contributions won't have
landed yet when this plugin reads them.

## Options

```yaml
plugins:
  - package: jsr:@steno/plugin-analytics # declares its own CSP sources
  - package: jsr:@steno/plugin-csp # must run after any contributing plugin
    options:
      mode: meta
      extraSources:
        script-src: []
        connect-src: []
      reportOnly: false
```

| Option           | Type                       | Default                                                                     | Description                                                                                                                                                                                                                     |
| ---------------- | -------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`           | `"meta" \| "header"`       | `"meta"`                                                                    | `"header"` writes a Netlify/Cloudflare-Pages-style `_headers` file to `<output>/_headers`; see "`mode: header` file format" below for exactly which hosts that covers -- there is no automatic fallback for unrecognized hosts. |
| `baseDirectives` | `Record<string, string[]>` | `{ "default-src": ["'self'"], "style-src": ["'self'", "'unsafe-inline'"] }` | Starting directive set before contributions/extras are merged in.                                                                                                                                                               |
| `extraSources`   | `Record<string, string[]>` | `{}`                                                                        | Site-specific additions per directive, merged in after plugin contributions.                                                                                                                                                    |
| `reportOnly`     | `boolean`                  | `false`                                                                     | Emits `Content-Security-Policy-Report-Only` instead of the enforcing header/meta tag, for staged rollout.                                                                                                                       |
| `reportUri`      | `string \| undefined`      | `undefined`                                                                 | Appends `report-uri <uri>; report-to default` to the policy when set.                                                                                                                                                           |

## How it works

1. `beforeBuild` merges directives, per key, in this order: `baseDirectives`, then any sources
   contributed by earlier plugins via `config.globals.__cspContributions` (see "Cross-plugin
   contract" below), then `extraSources`. Repeated source tokens for the same directive are
   de-duplicated; directives are emitted in sorted (alphabetical) order in the final policy string,
   so output is deterministic regardless of plugin/option ordering.
2. If `reportUri` is set, appends `report-uri <uri>; report-to default` to the policy.
3. Delivers the policy per `mode`:
   - `"meta"` (default): pushes a `MetaHeadTag` (`http-equiv="Content-Security-Policy"`, or
     `Content-Security-Policy-Report-Only` when `reportOnly` is true) into `config.head` during
     `beforeBuild`.
   - `"header"`: writes a Netlify/Cloudflare-Pages-style `_headers` file to `<output>/_headers`
     during `afterBuild`.

### Cross-plugin contract

`StenoPlugin` has no dedicated "declare your CSP needs" hook, so contributing plugins use a shared,
fixed convention: pushing into `config.globals.__cspContributions` during their own `beforeBuild`.

```ts
// config.globals.__cspContributions: Record<string, string[]>
// keyed by CSP directive name (e.g. "script-src", "connect-src"), values are additional source
// tokens.
const globals = (config.globals ??= {});
const existing = (globals.__cspContributions as Record<string, string[]> | undefined) ?? {};
for (const [directive, sources] of Object.entries(myContribution)) {
  existing[directive] = [...(existing[directive] ?? []), ...sources];
}
globals.__cspContributions = existing;
```

This plugin reads that slot **defensively** -- `readCspContributions` (exported from `mod.ts`) returns
`undefined` when the slot is absent (no contributing plugin ran, or ran with nothing to contribute)
rather than throwing. Any plugin following this same convention composes automatically; no single
plugin owns the contract exclusively.

### `mode: "meta"` vs `mode: "header"`

`types.ts` gives head tags a dedicated, validated shape (`MetaHeadTag`, part of the `HeadTag` union)
with a `key` field specifically for stable merge identity -- "page entries with the same key replace
site entries." That's a materially better fit for `mode: "meta"` than string surgery in
`transformHtml` would be: `transformHtml` runs per page over already-rendered HTML, re-inserting the
same site-wide tag on every page and needing to find-and-replace a previous plugin's tag string by
string. Pushing a `MetaHeadTag` into `config.head` during `beforeBuild` runs once, lets the theme's
own head-rendering own the actual markup, and gives page frontmatter a documented override path via
the same `key` merge identity.

`mode: "header"` has no `config.head` equivalent -- an actual HTTP response header is a host/server
concern, not a document concern -- so it's handled separately, in `afterBuild`, by writing a file.

#### `mode: "header"` file format

There is no target host specified for this plugin, and Steno's `SiteConfig` has no host/deploy target
field to key off of, so `mode: "header"` implements exactly one convention rather than guessing:

- **Supported:** the [Netlify](https://docs.netlify.com/routing/headers/) /
  [Cloudflare Pages](https://developers.cloudflare.com/pages/configuration/headers/) `_headers`
  convention -- a plain-text file at the output root, one `/*` block applying the policy to every
  route.
- **Not supported:** Vercel (`vercel.json`'s `headers` array, JSON not text), a raw web-server config
  (`nginx.conf`/`.htaccess`), or any host without a build-output-relative headers-file convention.
  Using `mode: "header"` on one of those hosts produces a `_headers` file that host ignores -- pick
  `mode: "meta"` instead, or post-process the written file into your host's own format.

There is no automatic fallback to `mode: "meta"` for an unrecognized host.

## Test

```sh
deno task test
```

## Learn more

- [Steno plugin development guide](https://github.com/stenopress/steno/blob/main/docs/plugins.md)
- [@steno/plugin-analytics](../plugin-analytics/README.md) -- an example plugin that contributes CSP sources this one consumes
- [MDN: Content-Security-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy)

## License

MIT
