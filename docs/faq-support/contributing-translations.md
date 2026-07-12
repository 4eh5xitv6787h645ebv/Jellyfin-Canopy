# How can I contribute translations?

Translations live as JSON files in the repository — one per locale in
`Jellyfin.Plugin.JellyfinElevate/js/locales/`. To add or update a language, edit
the relevant file and open a pull request; there is no external translation
platform to sign up for.

### Add or update a language

1. Go to `Jellyfin.Plugin.JellyfinElevate/js/locales/`
2. To add a new language, copy `en.json` (the base language) and rename it to your
   language code — an ISO 639-1 code, optionally with an ISO 3166-1 region
   (e.g. `es.json`, `pt-BR.json`, `zh-HK.json`). To update an existing language,
   edit its file in place.
3. Translate the English strings, leaving every placeholder token
   (`{name}`, `{count}`, `{{icon:name}}`) exactly as it appears in `en.json`.
4. Run the validator locally: `npm run validate-translations`
5. Commit your changes and open a pull request.

When a pull request touches any `js/locales/*.json` file, the **Translation
Checks** workflow re-runs the same validation and gates the merge — a locale that
is missing keys, drops a placeholder, or leaves a value blank fails CI. All 26
locales must stay in sync with `en.json`.

### What the validator checks

`scripts/validate-translations.js validate [lang]` compares every locale against
`en.json` and **fails** (exits non-zero) — rather than merely warning — when a
locale has:

- **Placeholder mismatches** — a placeholder token present in `en.json` but
  dropped or malformed in the locale. Both shapes are enforced: icon tokens
  (`{{icon:name}}`, matched as the whole token so a renamed or single-brace
  `{{icon:name}` is caught) and simple params (`{name}`, `{count}`, numbered
  `{0}`).
- **Empty or blank values** — a key whose value is an empty or whitespace-only
  string.
- **Non-string values** — a value that is not a string (a nested object, array,
  number or boolean from a bad export or hand edit); it is reported as an error
  instead of crashing the run.
- **Missing keys** — a key in `en.json` that the locale does not define.

Extra keys and extra placeholders (present in the locale but not in `en.json`)
stay non-fatal warnings.

The comparison logic is unit-tested in `scripts/validate-translations.test.js`,
run with `npm run test:scripts` (also a CI step); that suite additionally
validates every shipped locale against `en.json`, so a broken locale fails the
build.

### Translation Updates

- Synced from repository updates (merged locale-file PRs)
- Cached for 24 hours
- Available immediately after merge
- No plugin update needed

### Language Discovery

The language selector lists the available translations by asking the plugin's own
server endpoint (`/JellyfinElevate/locales`) which locale files ship with the
installed build. The browser does **not** call GitHub to discover languages, so
the list is correct on isolated networks and is never affected by GitHub's
anonymous rate limits. A newly-merged locale file becomes selectable once it is
part of an installed plugin build.
