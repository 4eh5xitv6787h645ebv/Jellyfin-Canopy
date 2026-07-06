## How can I contribute translations?

### Translate on Weblate (Recommended)

Use Weblate for all translation work:

<a href="https://hosted.weblate.org/engage/jellyfinenhanced/">
<img src="https://hosted.weblate.org/widget/jellyfinenhanced/287x66-grey.png" alt="Translation status" />
</a>

- https://hosted.weblate.org/projects/jellyfinenhanced/

1. Open the Jellyfin Enhanced project in Weblate
2. Select your language (or request a new one)
3. Translate strings in the web editor
4. Save your changes

### Why Weblate?

- No local setup required
- Translation quality checks are built in
- Faster review and sync workflow
- Keeps all language work in one place

### Maintainer Fallback: Manual JSON Changes

If Weblate is temporarily unavailable, maintainers can still update locale files directly:

1. Go to `Jellyfin.Plugin.JellyfinEnhanced/js/locales/`
2. Copy `en.json`
3. Rename to your language code (e.g., `es.json`)
4. Translate all English text
5. Run translation validation script
6. Submit a Pull Request

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

- Synced from repository updates (including Weblate commits)
- Cached for 24 hours
- Available immediately after merge
- No plugin update needed

### Language Discovery

The language selector lists the available translations by asking the plugin's own
server endpoint (`/JellyfinEnhanced/locales`) which locale files ship with the
installed build. The browser does **not** call GitHub to discover languages, so
the list is correct on isolated networks and is never affected by GitHub's
anonymous rate limits. A newly-merged locale file becomes selectable once it is
part of an installed plugin build.
