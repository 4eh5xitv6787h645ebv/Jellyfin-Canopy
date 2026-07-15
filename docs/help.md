# Help & Community

Most questions about Jellyfin Canopy have a short answer and a clear fix, and this page collects them in one place: a practical FAQ, general troubleshooting, and the exact channels for reporting bugs, proposing ideas, translating the plugin, and reaching other users. For problems that are specific to one feature, each feature guide has its own troubleshooting section — this page links you there when that is the faster route.

## Frequently asked questions

Quick answers to the things people ask most. If your problem is confined to one area, the [Troubleshooting](#troubleshooting) section and the feature guides go deeper.

### The basics

#### What is Jellyfin Canopy?

Jellyfin Canopy is a comprehensive plugin that bundles advanced features and customizations for Jellyfin in one package. It adds keyboard shortcuts, visual enhancements, Seerr integration, custom pause screens, quality tags, and much more — so you get a stack of upgrades from a single install rather than juggling several plugins and scripts.

#### Which apps and platforms does it work on?

Jellyfin Canopy runs on any client that uses Jellyfin's embedded web UI. That includes the official Jellyfin web UI, the desktop apps, and the official Android and iOS apps — every feature is available as long as the app renders Jellyfin's web interface.

It does **not** work on Android TV or other native TV apps, because those clients don't use the embedded web UI.

#### Can I customize the keyboard shortcuts?

Yes. Open the Jellyfin Canopy panel — click its item in the sidebar or press `?` — then go to the **Shortcuts** tab. Click any key to set a custom shortcut. Changes save automatically. See [The Enhanced Experience](enhanced.md) for the full shortcut list.

#### How do I change the plugin's language?

The plugin automatically follows the language set in your Jellyfin user profile. If your language isn't available yet, it falls back to English. If you'd like to add or improve a language, see [Translate Jellyfin Canopy](#translate-jellyfin-canopy).

#### Is Jellyfin Canopy affiliated with Seerr?

No. Seerr is an independent project; Jellyfin Canopy integrates with it to enrich the Jellyfin experience.

!!! warning "Report plugin issues to this repository"

    Please report plugin issues to the [Jellyfin Canopy repository](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues), **not** to the Seerr team.

#### Whatever happened to the userscript?

The userscript has been discontinued — the plugin's functionality has grown well beyond what a userscript could carry. If you only need basic keyboard shortcuts, the last userscript version is still available [here](https://github.com/n00bcodr/Jellyfin-Enhanced/raw/05dd5b54802f149e45c76102dabf6235aaf7a5fb/jf_enhanced.user.js).

### Installation and compatibility

#### Which Jellyfin versions are supported?

Jellyfin Canopy targets Jellyfin 12.

| Plugin | Jellyfin 12 | Jellyfin 10.11 | Notes |
|--------|:-----------:|:--------------:|-------|
| Jellyfin Canopy | ✅ | ❌ | On Jellyfin 10.11, install the original [Jellyfin Enhanced](https://github.com/n00bcodr/Jellyfin-Enhanced) plugin instead. |

If you're moving up from a 10.11 setup, [Getting Started](getting-started.md) walks through the migration to v12.

#### The plugin, scripts, or an update didn't show up

These are all installation-environment issues rather than plugin bugs, and [Getting Started](getting-started.md) has the step-by-step fixes:

- **Plugin not appearing after installation** — check the plugin repository and restart steps.
- **Scripts not loading** — scripts are injected at request time by the built-in middleware in the default configuration; see the scripts-not-loading fix.
- **Update not applying** — clear the plugin cache and force a browser refresh with ++ctrl+f5++.
- **"Permission denied" errors in the logs** — a file-permission problem on the Jellyfin install directory; see the permissions section.

### Features not behaving

#### Auto-skip intros isn't working

Auto-skip reads Jellyfin 12's native **Media Segments** and seeks to each segment's exact end boundary. It therefore needs media segments to exist for your media, which are produced by a segment provider such as the [Intro Skipper plugin](https://github.com/intro-skipper/intro-skipper) — Jellyfin Canopy does not detect intros itself.

To get it working:

1. Install a media segment provider (for example, the Intro Skipper plugin).
2. Enable intro/outro detection in that provider's settings.
3. Run detection on your library so segments are created.
4. Enable auto-skip in Jellyfin Canopy settings (Intro and/or Outro).
5. Confirm segments were detected for your media (check `GET /MediaSegments/{itemId}`).

!!! note "How the skip behaves"

    - Skipping honors the segment's exact end (`StartTicks`/`EndTicks`), so a provider offset is respected.
    - Seeking back into a segment after an auto-skip won't immediately re-skip it. Rewinding to *before* the segment and playing forward through it again skips again — matching Jellyfin's native Skip action.
    - Recap, Preview, and Commercial segments are handled by Jellyfin's native per-type segment actions, not by these toggles.

A quick sanity check: play a video with a known intro and look for the "Skip Intro" button. If it appears, detection is working. If it doesn't, run intro detection again. Auto-skip is covered in full in [The Enhanced Experience](enhanced.md).

#### Seerr won't connect

Work through the connection basics first:

1. Verify the Seerr URL is correct and reachable.
2. Verify the API key is correct (from **Seerr → Settings → General**).
3. Click **Test** in the Seerr plugin settings.
4. Check the icon status on the search page:

    - 🟢 **Active** — working
    - 🔴 **No Access** — user not imported
    - ⚫ **Offline** — cannot connect

Most "No Access" cases come down to sign-in and user import. In Seerr, go to **Settings → Users**, turn on **Enable Jellyfin Sign-In**, and import your Jellyfin users.

![Jellyfin Sign-In](images/jellyfin-signin.png)

Then import users using whichever route you prefer:

=== "Automatic (recommended)"

    1. In Jellyfin, go to **Dashboard → Plugins → Jellyfin Canopy → Seerr**.
    2. Enable **Auto import Jellyfin users to Seerr**.
    3. Optionally click **Import Users Now** to run a bulk import immediately.

=== "Manual (in Seerr)"

    1. In Seerr, open the **Users** page.
    2. Click **Import Jellyfin Users**.
    3. Select the users to import.
    4. Save changes.

A user with access looks like this:

![Users with access](images/users-with-access.png)

A user without access looks like this:

![Users without access](images/users-no-access.png)

If it still won't connect, check the logs from three places: the browser console (++f12++) for client errors, the Jellyfin server logs for proxy errors, and the Seerr logs for API errors. The full Seerr setup lives in [Discover & Request](discover.md).

#### Poster tags aren't showing up

First, make sure the tags are enabled and your browser isn't serving a stale cache:

1. Open the Enhanced panel (press `?`) and go to the **Settings** tab.
2. Enable the tags you want — **Quality Tags**, **Genre Tags**, **Language Tags**, **Rating Tags** — and adjust their position if needed.
3. Hard-refresh the browser with ++ctrl+f5++, clear the browser cache, and restart the browser if tags still look stale.

If they're still missing, rebuild the tag cache. Poster tags are drawn from a server-side cache that the plugin keeps current *incrementally* as your library changes, and rebuilds nightly via the **Build Tag Cache** scheduled task. To force a rebuild:

1. Go to **Dashboard → Scheduled Tasks**.
2. Under **Jellyfin Canopy**, find **Build Tag Cache**.
3. Run it manually (click `▶︎`).
4. Hard-refresh your browser (++ctrl+f5++) once it finishes.

!!! tip "First install"

    The server-side tag cache is built automatically on the first startup after install, and rebuilt nightly. If poster tags still don't appear, trigger a rebuild manually with **Build Tag Cache** (Dashboard → Scheduled Tasks).

Finally, remember that tags need the underlying metadata to draw from: quality tags require media-file metadata, genre tags require genre information, language tags require audio-track data, and rating tags require TMDB/RT ratings. If a tag type is empty everywhere, check that its metadata exists. For persistent problems, press ++f12++, open the Console, look for tag-related errors, and report them on GitHub. Tags and overlays are documented in [The Enhanced Experience](enhanced.md).

#### Bookmarks aren't syncing across devices

The same user account should reach the same bookmarks from any device, because bookmark *data* is stored on the server. Your *settings*, however, are stored per-browser — so behavior can differ between browsers even for the same user.

!!! info "What lives where"

    **Stored on the Jellyfin server (syncs across devices):**

    - Bookmark data — `bookmark.json` (see [Developer Guide](developers.md))
    - [Spoiler Guard](spoiler-guard.md) per-user list and override preferences — `spoilerblur.json`

    **Stored in each browser's `localStorage` (independent per browser):**

    - Your Canopy settings (see [The Enhanced Experience](enhanced.md))

To troubleshoot missing bookmarks:

- Confirm you're signed in as the same user account.
- Confirm the bookmark file exists on the server, at `/config/plugins/configurations/Jellyfin.Plugin.JellyfinCanopy/{userId}/bookmark.json`. Here `{userId}` is your user ID with all hyphens removed and converted to lowercase — for example `12345678-90AB-...` becomes the folder `1234567890ab...`.
- Check the browser console for errors.

#### The custom pause screen won't appear

Two things need to be true. First, enable the feature: open the Enhanced panel, go to the **Settings** tab, turn on **Enable Custom Pause Screen**, and adjust the options to taste. Second, be in the right playback mode — the pause screen only shows in fullscreen or theater mode. Pause the video (press Space) and the screen appears after a brief delay.

To hide or restyle individual elements of the pause screen, see the pause-screen CSS in the [Reference](reference.md).

#### Reviews, Elsewhere, or Seerr icons are missing

This is usually a TMDB API access problem rather than a plugin fault. TMDB's API may be blocked in your region.

- Review Seerr's own guidance on [TMDB access](https://docs.seerr.dev/troubleshooting#tmdb-failed-to-retrievefetch-xxx).
- Try a VPN or proxy if TMDB is blocked where you are.
- Ask your ISP about API access if the block is network-level.

To confirm, open the browser console (++f12++), look for TMDB-related errors, check the Network tab for failed requests, and verify Seerr itself can reach TMDB. These features are covered in [Discover & Request](discover.md).

#### Is "Remove from Continue Watching / Next Up" destructive?

**No — it's non-destructive.** Your playback position and watched state are always preserved. Removing an item only hides it from the **Continue Watching** (and **Next Up**) row.

How it works:

- It adds a **Remove** option to an item's "⋯" menu — and to the long-press / multi-select menu on touch devices — for Continue Watching and Next Up items.
- It hides the item from that row only. Your progress is **not** reset, and the item is **not** marked played.
- The hidden state is stored server-side per-user, so it applies across all your devices.

And yes, it's reversible: removed items appear in the **Hidden Content** management page, where each has an **Add back** button, and *resuming* a hidden item unhides it automatically. This is a tidy way to clear the Continue Watching / Next Up rows without losing your place. See [The Enhanced Experience](enhanced.md) for more.

### Customization

#### How do I restyle tags with CSS?

Add custom rules through Jellyfin's built-in Custom CSS:

1. Go to **Dashboard → General → Custom CSS**.
2. Add your styles.
3. Click **Save**.
4. Refresh the browser (++ctrl+f5++).

A few common recipes:

```css title="Hide a quality tag"
.quality-overlay-label[data-quality="H264"] {
    display: none !important;
}
```

```css title="Change a tag color"
.quality-overlay-label[data-quality="4K"] {
    background-color: purple !important;
}
```

```css title="Adjust tag size"
.quality-overlay-label {
    font-size: 0.9rem !important;
    padding: 4px 8px !important;
}
```

The full selector reference is in the [Reference](reference.md) CSS guide.

#### How do I upload custom branding?

You'll need admin access to Jellyfin.

!!! info "No extra plugin needed"

    Custom branding is served by Jellyfin Canopy's own built-in request-time middleware, which swaps in your uploaded logo, banner, and favicon as jellyfin-web requests them. You do **not** need the File Transformation plugin (or any other plugin) for this.

To upload:

1. Go to **Dashboard → Plugins → Jellyfin Canopy**.
2. Open the **Extras** tab.
3. Find the **Custom Image Assets** section.
4. Upload your images:

    - **Icon Transparent** — header logo
    - **Banner Light** — dark-theme splash
    - **Banner Dark** — light-theme splash
    - **Favicon** — browser icon

5. Click **Save**.
6. Force-refresh with ++ctrl+f5++.

For best results, use PNG or SVG with transparent backgrounds for logos, at dimensions appropriate to each asset. Uploaded files are stored in the plugin config folder. Branding options are covered in full in [Customization](customization.md).

#### Can I move tags to a different corner?

Yes, from the Enhanced panel:

1. Open the Enhanced panel (press `?`) and go to the **Settings** tab.
2. Find the tag position options.
3. Choose a position — top-left, top-right, bottom-left, or bottom-right.
4. Changes apply immediately.

For pixel-level control, override the container position with CSS:

```css title="Fine-tune tag position"
.quality-overlay-container {
    top: 10px !important;
    right: 10px !important;
}
```

## Troubleshooting

When something misbehaves, the fastest path is usually to gather the right logs, check the error against the table below, and rule out conflicts. This section covers the cross-cutting problems.

!!! tip "Feature-specific troubleshooting lives with each feature"

    For issues tied to one area, go straight to that guide: [The Enhanced Experience](enhanced.md) (shortcuts, tags, pause screen, auto-skip, bookmarks, hidden content), [Discover & Request](discover.md) (Elsewhere, Discovery, Seerr, reviews), [Sonarr & Radarr](sonarr-radarr.md) (the \*arr integration and its calendar/requests pages), [Spoiler Guard](spoiler-guard.md), and [Getting Started](getting-started.md) (install, migration, permissions).

### Gather logs before you report

Good logs turn a vague report into a fixable one. Collect from all three sources when you can.

**Browser console logs**

1. Press ++f12++ to open developer tools.
2. Go to the **Console** tab.
3. Filter by `🪼 Jellyfin Canopy`.
4. Look for errors (red text) and copy the messages.

**Network logs**

1. Press ++f12++ and open the **Network** tab.
2. Filter by `JellyfinCanopy`.
3. Look for failed requests (red) and note their status codes.

**Server logs**

1. Go to **Dashboard → Logs**.
2. Look for `JellyfinCanopy` entries.
3. Check the log files named `JellyfinCanopy_yyyy-mm-dd.log`.
4. Copy the relevant errors.

When you write up the report, include: the plugin version, Jellyfin version, browser and version, operating system, exact steps to reproduce, the console errors, the server-log errors, and screenshots where they help.

### Common errors and fixes

| Error | Solution |
|-------|----------|
| `Access to the path '/jellyfin/jellyfin-web/index.html' is denied.` | Install the [File Transformation plugin](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) or follow the Docker workaround in [Getting Started](getting-started.md). |
| `Access to the path 'C:\Program Files\Jellyfin\Server\jellyfin-web\index.html' is denied.` | Grant "NETWORK SERVICE" Read/Write permissions to the Jellyfin folder. |
| Plugin installed but scripts don't load | Scripts are injected at request time by the built-in middleware in the default config — see the scripts-not-loading fix in [Getting Started](getting-started.md). The "Jellyfin Canopy Startup" task only matters in the legacy on-disk `index.html` rewrite mode. |
| Reviews / Elsewhere / Seerr icons not working | TMDB API may be blocked in your region — see [Seerr's TMDB troubleshooting](https://docs.seerr.dev/troubleshooting#tmdb-failed-to-retrievefetch-xxx). |
| Seerr search not working | Enable "Jellyfin Sign-In" in Seerr, then either enable plugin auto-import and run "Import Users Now" or import users manually in Seerr. Also verify the user isn't on the blocked-users list. |
| Tags not appearing | Enable them in settings, clear the cache, and verify the metadata exists (see [Poster tags aren't showing up](#poster-tags-arent-showing-up)). |
| Bookmarks not saving | Check the server logs and verify the user data folder permissions. |
| Admin config page tabs not switching | May be caused by Cloudflare Rocket Loader — try disabling it for your Jellyfin domain. See [Getting Started](getting-started.md). |
| Calendar / Requests custom tab shows a blank screen | Disable Cloudflare Rocket Loader for your Jellyfin domain. See [Sonarr & Radarr](sonarr-radarr.md). |

### Plugin conflicts

No conflicts are currently documented. That said, a few situations are worth ruling out if scripts or styles misbehave:

- Multiple JavaScript-injection plugins running at once.
- Custom CSS overriding the plugin's own styles.
- Browser extensions blocking scripts.

To isolate a conflict, temporarily disable other plugins, test in a clean browser profile, check for CSS clashes, and disable browser extensions one at a time. If you confirm a genuine conflict, report it on GitHub so it can be documented.

### Performance

If the UI feels heavy, the usual cause is having more turned on than you need:

- Disable features you don't use.
- Reduce the number of visible tags, and use tag filters to limit what's displayed.
- Clear the browser cache regularly and keep your browser up to date.
- Clear out old bookmarks and check your server's resources.

The features that cost the most are the Seerr discovery pages (many API calls), People tags (age calculations), having several tag types enabled at once, and very large bookmark collections. Limiting Seerr results and enabling only the features you actually use keeps things responsive.

## Report an issue

Bug reports go to **GitHub Issues**. A clear, reproducible report is the single biggest thing you can do to get a fix quickly.

!!! tip "A good bug report includes"

    - A clear description
    - Steps to reproduce
    - Expected vs. actual behavior
    - The plugin version and the Jellyfin version
    - Your browser and OS
    - Console and server logs
    - Screenshots

**Before reporting**

1. Search the [existing issues](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues) — someone may have hit it already.
2. Verify the plugin is up to date.
3. Test with a clean browser profile.
4. Gather logs — see [Gather logs before you report](#gather-logs-before-you-report).

**Open the issue**

1. Go to [GitHub Issues](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues/new).
2. Use the bug-report template.
3. Include all the requested information.
4. Attach your logs and screenshots.
5. Submit.

## Request a feature

Have an idea? Feature proposals are gathered, discussed, and prioritized in **[GitHub Discussions](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/discussions)** — not in Issues.

1. Check the [existing discussions](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/discussions) to see whether your idea is already there.
2. Start a new discussion in the **Ideas** category.
3. Describe the feature clearly.
4. Explain the use case and who benefits.
5. Be open to discussion.

The strongest requests pair a clear description with a concrete use case, add mockups or examples where they help, and take existing features into account.

## Translate Jellyfin Canopy

Jellyfin Canopy ships its translations as JSON files in the repository — one per locale in `Jellyfin.Plugin.JellyfinCanopy/js/locales/`. The repository's [`locale-manifest.json`](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/blob/main/Jellyfin.Plugin.JellyfinCanopy/locale-manifest.json) is the canonical supported-language list. Adding or improving a language is a plain pull request: edit a file and open a PR. There's **no external translation platform to sign up for** and no Weblate — the workflow is validated entirely in CI.

### Add or update a language

1. Go to `Jellyfin.Plugin.JellyfinCanopy/js/locales/`.
2. To add a new language, copy `en.json` (the base language) and rename it to your language code — an ISO 639-1 code, optionally with an ISO 3166-1 region (for example `es.json`, `pt-BR.json`, `zh-HK.json`). To update an existing language, edit its file in place.
3. Translate the English strings, leaving every placeholder token — `{name}`, `{count}`, `{{icon:name}}` — exactly as it appears in `en.json`.
4. Run the validator locally: `npm run validate-translations`.
5. Commit your changes and open a pull request.

When a pull request touches a locale or the inventory, the **Translation Checks** workflow validates the complete registered set and gates the merge. Missing or unregistered files, case/region-code drift, missing keys, dropped placeholders, and blank values all fail CI. Intentional language additions or removals must update the inventory and its documented count in the same reviewed migration.

### What the validator checks

`scripts/validate-translations.js validate [lang]` compares every locale against `en.json` and **fails** (exits non-zero) — rather than merely warning — when a locale has:

- **Placeholder mismatches** — a placeholder token present in `en.json` but dropped or malformed in the locale. Both shapes are enforced: icon tokens (`{{icon:name}}`, matched as the whole token, so a renamed or single-brace `{{icon:name}` is caught) and simple params (`{name}`, `{count}`, numbered `{0}`).
- **Empty or blank values** — a key whose value is an empty or whitespace-only string.
- **Non-string values** — a value that isn't a string (a nested object, array, number, or boolean from a bad export or hand edit); it's reported as an error instead of crashing the run.
- **Missing keys** — a key in `en.json` that the locale doesn't define.

Extra keys and extra placeholders (present in the locale but not in `en.json`) stay non-fatal warnings. The comparison logic is unit-tested in `scripts/validate-translations.test.js`, run with `npm run test:scripts` (also a CI step); that suite additionally validates every shipped locale against `en.json`, so a broken locale fails the build.

### How translations reach users

Translations are synced from repository updates (merged locale-file PRs) and cached for 24 hours. A merged locale is available immediately after merge — no plugin update is needed.

The language selector lists the available translations by asking the plugin's own server endpoint (`/JellyfinCanopy/locales`) which locale files ship with the installed build. The browser does **not** call GitHub to discover languages, so the list is correct on isolated networks and is never affected by GitHub's anonymous rate limits. A newly-merged locale file becomes selectable once it's part of an installed plugin build.

## Community and support

There are three official channels, each suited to a different kind of question:

- **[GitHub Issues](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues)** — bug reports (see [Report an issue](#report-an-issue)).
- **[GitHub Discussions](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/discussions)** — feature ideas (see [Request a feature](#request-a-feature)) and general questions.
- **[Discord Community](https://discord.gg/EYNFf7y4CG)** — real-time chat and support.

The source lives in the [Jellyfin Canopy GitHub repository](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy).

**Before you ask**

1. Read this FAQ.
2. Check [Getting Started](getting-started.md).
3. Review [The Enhanced Experience](enhanced.md).
4. Search the existing issues.
5. Check the browser console for errors.

**When you ask for help**

- Describe the problem clearly.
- Include the plugin and Jellyfin versions.
- Provide your browser and OS.
- Share the relevant logs.
- Include screenshots if they help.
- Be patient and respectful.

For other projects and recommended companion plugins, see [About](about.md).
