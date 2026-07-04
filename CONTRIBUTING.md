# Contributing to Jellyfin Enhanced

Thank you for your interest in contributing to Jellyfin Enhanced! This document provides guidelines and information to help you get started.

## 🤝 Ways to Contribute

### 1. Code Contributions

You can contribute code through:
- **Open Pull Requests**: Check the [open PRs](https://github.com/n00bcodr/Jellyfin-Enhanced/pulls) for issues that need help
- **Discussions**: Browse [Discussions](https://github.com/n00bcodr/Jellyfin-Enhanced/discussions) for feature requests and ideas that interest you
- **Bug Fixes**: Fix any bugs you encounter and submit a PR

> [!NOTE]
> Feature requests that are considered niche use cases are often moved to Discussions. Feel free to implement any of these if they interest you!

### 2. Translation Contributions

Help make Jellyfin Enhanced accessible to more users by contributing translations through Weblate:

- https://hosted.weblate.org/projects/jellyfinenhanced/

See the [Contributing Translations](/Jellyfin-Enhanced/faq-support/contributing-translations/) section for details.

## 🚀 Getting Started

### Project Structure

The plugin is one C# project (server) plus one TypeScript module tree (client), bundled into a single client artifact:

- `Jellyfin.Plugin.JellyfinEnhanced/src/` — **the client.** TypeScript ES modules (strict mode, real imports), organized by area: `core/` (platform layer: navigation, lifecycle, dom-observer, ui-kit, api-client, live), `enhanced/`, `jellyseerr/`, `arr/`, `tags/`, `elsewhere/`, `extras/`, `others/`. Each area has an `index.ts` barrel; `src/main.ts` imports the barrels; `scripts/build-bundle.js` (esbuild) produces `dist/je.bundle.js`.
- `Jellyfin.Plugin.JellyfinEnhanced/Controllers/` — one small feature controller per HTTP surface, all deriving from `JellyfinEnhancedControllerBase`.
- `Jellyfin.Plugin.JellyfinEnhanced/Configuration/` — `PluginConfiguration.cs` (admin settings), `SettingDescriptors.cs` (the settings registry — the single source of truth for what reaches clients), the admin config page.
- `Jellyfin.Plugin.JellyfinEnhanced.Tests/` — xUnit tests, including golden snapshots that pin the config payload contract.
- `e2e/` — the committed Playwright suite + `e2e/docker/` (dockerized, seeded Jellyfin 12 for CI and local runs).
- `docs/` — the MkDocs site, including **[`docs/v12-platform.md`](docs/v12-platform.md) — read this before touching injection, navigation or websocket code.** It is the evidence-based reference for how the Jellyfin 12 web client actually behaves (stable anchors, re-render survival, router traps, auth policy contract).

See the [Project Structure](README.md#-project-structure) section in the README for the full breakdown.

## 🛣️ The Paved Road — adding a feature

Every feature is four small, declarative pieces. Start from the scaffolder:

```bash
node scripts/new-feature.js my-feature            # --area arr|jellyseerr|... , --dry-run
```

It generates a typed client module, a controller, an e2e spec stub and a docs stub — every gap marked `TODO(my-feature)` — wires the module into its area barrel, and prints the remaining wiring checklist. What each piece looks like:

1. **A setting = a descriptor + a `data-config-key` attribute.**
   Add the property to `PluginConfiguration.cs`, register it in `SettingDescriptors.BuildRegistry()` (`Public(...)` / `Private(...)` / `PublicUser(...)` for per-user overrides — exposure lists are whitelists; secrets never get a descriptor), and add a control with `data-config-key="MyFeatureEnabled"` to `Configuration/configPage.html` — the config-page binder loads/saves every `data-config-key` automatically. The golden snapshot tests pin the payload contract, so a renamed or leaked setting fails CI.

2. **An endpoint = a small controller + a policy attribute.**
   A class deriving from `JellyfinEnhancedControllerBase` with `[Route("JellyfinEnhanced")]`. Auth is declarative: bare `[Authorize]` for any authenticated user, `[Authorize(Policy = Policies.RequiresElevation)]` for admin-only (returns a bare 403 with an empty body — clients branch on status code alone; JSON envelopes are for business errors only).

3. **UI = a typed module over `JE.core`.**
   Import `JE` from `src/globals`, register a lifecycle handle (`JE.core.lifecycle` — tracked resources get torn down cleanly), inject via `JE.core.dom.ensureInjected(key, anchorFn, buildFn)` — durable, idempotent, re-attaches across React re-renders, param-only navigations and the `/video` round trip — and build markup with the ui-kit (`JE.core.ui.muiIconButton` / `muiMenuItem` / `sectionContainer`) so it wears native MUI classes and theme tokens. Type the public surface as an interface and augment `JEGlobal` — the `window.JellyfinEnhanced` contract stays compile-checked.

4. **Live updates = `JE.core.live.on(LIVE.*)`.**
   Subscribe to `LIVE.CONFIG_CHANGED` (admin saved config — re-init instead of requiring a reload), `LIVE.LIBRARY_CHANGED`, or `LIVE.USER_DATA_CHANGED` instead of polling. The server side pushes through `ISessionManager` (see `Services/LiveNotifierService.cs`).

5. **Proof = an `e2e/` spec.**
   Extend the stub: log in with the `loginAs` fixture, drive the feature, assert what the user sees, and assert `consoleErrors.real()` is empty. Specs must be idempotent and restore any server state they touch.

## 📝 Code Contribution Guidelines

### Code Style

1. **New client code is TypeScript.**

   New client modules are ES modules under `Jellyfin.Plugin.JellyfinEnhanced/src/` (strict mode, real imports, unit tests where the logic is pure). The legacy `js/` tree is frozen except for conversions and bug fixes. New C# logic that can be tested without a running Jellyfin server should come with unit tests.

2. **Comments are Essential**

   - Use JSDoc/XML-doc comments for functions and classes
   - Add inline comments to explain complex logic — especially anything that exists because of a Jellyfin 12 platform quirk (link the `docs/v12-platform.md` section)
   - Document parameters, return values, and side effects

3. **Code Understanding**

   - Ensure you understand what your changes do
   - Be prepared to answer questions about your implementation
   - Test your changes thoroughly

4. **AI-Assisted Code (VibeCoded PRs)**

   - AI-assisted contributions are welcome! However:
     - You must understand what the code does
     - Be able to explain your implementation
     - Respond to code review comments
     - Clearly indicate in your PR description that AI tools were used

   Example PR description:
   ```markdown
   ## Description
   Adds feature X to improve Y

   ## Implementation Notes
   This PR was developed with AI assistance (Claude/GPT/etc.). I have reviewed
   and tested all changes and understand the implementation.

   ## Testing
   - [ ] Tested on Jellyfin 12
   - [ ] Verified no basic errors
   ```

### Pull Request Process

1. **Fork and Branch**
   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/bug-description
   ```

2. **Make Your Changes**

   - Start from the scaffolder / paved road above
   - Write clean, commented code
   - Follow existing code patterns
   - Test thoroughly

3. **Commit Messages**

   - Use clear, descriptive commit messages
   - Reference issues when applicable

   Example:
   ```
   feat: add bookmark sync across duplicate items

   - Implements automatic bookmark syncing based on TMDB/TVDB IDs
   - Adds UI option to manage sync preferences
   - Fixes #123
   ```

4. **Submit PR**

   - Provide a clear description of changes
   - Include screenshots/videos for UI changes as applicable
   - List any breaking changes
   - Mention if you used AI assistance

5. **Code Review**

   - Be responsive to feedback
   - Be prepared to make requested changes

## 🧪 Testing

### The gates (run these locally — CI enforces all of them)

```bash
# One-time setup
npm install

# Client
npm run typecheck:src          # tsc --strict over the TypeScript module tree (src/)
npm run lint                   # ESLint (errors gate CI; warnings are advisory)
npm run test:client            # vitest unit tests for src/ modules
npm run test:client:coverage   # + the src/core line-coverage ratchet
npm run build:bundle           # esbuild bundle — fails on unreachable src/ modules
npm run syntax                 # node --check on the frozen legacy js/ tree
npm run typecheck              # opt-in @ts-check over legacy js/ files

# Server (Jellyfin 12 / net10.0; TreatWarningsAsErrors — zero warnings)
dotnet build Jellyfin.Plugin.JellyfinEnhanced/JellyfinEnhanced.csproj -c Release
dotnet test                    # xUnit; add --collect:"XPlat Code Coverage" +
                               # node scripts/check-dotnet-coverage.js for the ratchet

# End-to-end (real browser against a real Jellyfin 12)
npm run e2e                    # JF_BASE_URL=... (default http://localhost:8099)
npm run e2e:headed             # watch it run
```

Coverage thresholds are **ratchets**: they were set just below measured coverage when introduced (`vitest.config.ts` for `src/core`, `scripts/check-dotnet-coverage.js` for the plugin assembly). Raise them as you add tests; never lower them.

### E2E against a disposable server

No dev server handy? The compose stack seeds a throwaway Jellyfin 12 with the freshly built plugin, generated media and the test users:

```bash
dotnet build Jellyfin.Plugin.JellyfinEnhanced/JellyfinEnhanced.csproj -c Release
bash e2e/docker/seed.sh                        # boots + seeds on port 8100
JF_BASE_URL=http://localhost:8100 npm run e2e
docker compose -f e2e/docker/compose.yml down -v
```

CI runs the same stack on every PR (advisory while the infrastructure earns trust).

### Docs

If you touch `docs/` (any user- or admin-visible change should), the site must build strictly:

```bash
mkdocs build --strict
```

### Manual checklist

Before submitting a PR, ensure you've tested:

- [ ] Feature works as expected
- [ ] No console errors
- [ ] Compatible with Jellyfin 12.x — **both** the modern (MUI) layout and the legacy layout (`localStorage.layout`)
- [ ] Works on different browsers (Chrome, Firefox, Edge)
- [ ] Doesn't break existing functionality
- [ ] Mobile compatibility (if applicable)
- [ ] Injected UI survives navigation and the `/video` round trip (see `docs/v12-platform.md` §3)

## 📋 Feature Request Guidelines

When proposing new features:

1. **Check Discussions First**: Your idea might already be there!
2. **Provide Context**: Explain the use case and benefit
3. **Be Specific**: Clear descriptions help implementation
4. **Consider Scope**: Is this a core feature or niche use case?

## 🐛 Bug Reports

When reporting bugs:

1. **Check Existing Issues**: Avoid duplicates
2. **Check FAQs**
3. **Provide Details** as per the Bug report template

## 💬 Getting Help

If you have questions or need help:

- **Discord**: Reach out on the [Jellyfin Community Discord](https://discord.gg/EYNFf7y4CG)
- **Discussions**: Start a discussion on GitHub
- **Issues**: For bug-related questions

## 🎨 UI/UX Contributions

For UI changes:

- Use the ui-kit (`JE.core.ui`) so injected UI matches native markup and follows the active theme
- Test with different Jellyfin themes and both layouts
- Provide before/after screenshots

---

**Thank you for contributing to Jellyfin Enhanced! Your efforts help make Jellyfin better for everyone.** 💜
