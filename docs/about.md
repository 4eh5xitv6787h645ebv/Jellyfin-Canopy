# About Jellyfin Canopy

Jellyfin Canopy is an independent fork and extensive modernization of [Jellyfin Enhanced](https://github.com/n00bcodr/Jellyfin-Enhanced) by [n00bcodr](https://github.com/n00bcodr), rebuilt from the ground up for **Jellyfin 12**. It bundles playback, discovery, customization, and media-management features into one plugin so you can shape how your server looks and behaves without stitching together a dozen scripts. This page tells you where it came from, who to thank for it, and which related projects pair well with it.

## What Jellyfin Canopy is

Jellyfin Enhanced started life as a userscript and grew into a full-featured plugin. Jellyfin Canopy continues that lineage on a different path: a Jellyfin 12-only rebuild rather than a port. Under the hood that means a strict-TypeScript ES-module client, policy-based server authorization, push-driven live updates, a committed Playwright end-to-end suite, and enforced performance rules — the plumbing you never see, but that keeps the features fast and predictable.

The project is developed **100% with AI** — agentic coding tools drive the design, implementation, testing, and review — directed and curated by a human maintainer. Nothing lands on trust alone: every change has to pass the full gate suite (type-checking, lint, unit tests, golden snapshots, and a live end-to-end run) before it ships.

!!! warning "On Jellyfin 10.11? Use Jellyfin Enhanced"
    Jellyfin Canopy targets **Jellyfin 12 only**. If your server is still on **Jellyfin 10.11**, install [Jellyfin Enhanced](https://github.com/n00bcodr/Jellyfin-Enhanced) instead — it is n00bcodr's original project and remains actively maintained for 10.11. When you are ready to move up, see [Getting Started](getting-started.md) for installation and migration.

The Jellyfin Canopy source lives at **[github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy)**. If you want the technical tour of how the plugin is put together, the [Developer Guide](developers.md) goes deep on the architecture, live updates, and performance rules.

## Credits & acknowledgments

Jellyfin Canopy exists because other people built the foundations first. Credit is due, and it is not a formality.

### The original author

**[n00bcodr](https://github.com/n00bcodr)** — creator of [Jellyfin Enhanced](https://github.com/n00bcodr/Jellyfin-Enhanced).

This project **would not exist without him**. Every feature in Jellyfin Canopy stands on the foundation he designed, built, and maintained. Jellyfin Enhanced remains actively maintained for Jellyfin 10.11 — if that is your server, use it. Every donation link in this project points to him on purpose: [Ko-Fi](https://ko-fi.com/n00bcodr) and [Buy Me a Coffee](https://www.buymeacoffee.com/n00bcodr).

### Special thanks

- **[The Jellyfin Team](https://jellyfin.org/)** — for creating and maintaining the open-source media server that makes all of this possible.
- **[BobHasNoSoul](https://github.com/BobHasNoSoul/)** — a huge inspiration for the original project's Jellyfin modding, and the original creator of [Jellyfin PauseScreen](https://github.com/BobHasNoSoul/Jellyfin-PauseScreen) and [Jellyfin Quality Tags](https://github.com/BobHasNoSoul/Jellyfin-Qualitytags/).
- **[IAmParadox27](https://github.com/IAmParadox27/)** — the inspiration for moving Jellyfin Enhanced from a userscript to a plugin, and the creator of excellent Jellyfin plugins including [File Transformation](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) and [Plugin Pages](https://github.com/IAmParadox27/jellyfin-plugin-pages).

And thanks to all the people who contributed to Jellyfin Enhanced, whose work carries forward into this fork:

<div align="center">
  <a href="https://github.com/n00bcodr/Jellyfin-Enhanced/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=n00bcodr/Jellyfin-Enhanced" alt="Jellyfin Enhanced contributors" />
  </a>
</div>

### The community

- **Translators** — the community members who contributed translations in 26 languages to the original project. Their work is what makes Jellyfin Canopy usable worldwide.
- **Bug reporters & testers** — the people who file issues, test features, and send back the feedback that makes the plugin better for everyone.
- **Feature requesters** — the users whose suggestions shape where the project goes next.

If you would like to join them, [Help & Community](help.md) explains how to report issues, request features, and contribute translations.

## Related projects

If you run Jellyfin Canopy, these are the projects worth knowing about: n00bcodr's related work, which you might install alongside it, and the plugins Canopy reaches out to when they are present.

### n00bcodr's projects

| Project | Type | What it is | Status |
| --- | --- | --- | --- |
| [Jellyfin Enhanced](https://github.com/n00bcodr/Jellyfin-Enhanced) | Plugin | The original project Canopy forked from — the **Jellyfin 10.11** counterpart. Use this if you are on 10.11. | Active (10.11) |
| [Jellyfin Tweaks](https://github.com/n00bcodr/JellyfinTweaks) | Plugin | Additional UI tweaks, performance options, and extra customization that complement Canopy. | Active |
| [Jellyfin JavaScript Injector](https://github.com/n00bcodr/Jellyfin-JavaScript-Injector) | Plugin | Inject custom JavaScript into the Jellyfin web interface without touching core files — useful for testing, prototyping, and standalone enhancements. | Active |
| [Jellyfin Elsewhere](https://github.com/n00bcodr/Jellyfin-Elsewhere) | JavaScript | The standalone version of the Elsewhere streaming-provider lookup. | Inactive |
| [Jellyfish](https://github.com/n00bcodr/Jellyfish/) | CSS theme | A modern Jellyfin theme with multiple color variants (Aurora, Jellyblue, Ocean, Sunset, Forest, and more). Designed to work well alongside Canopy. | Active |

!!! note "Elsewhere is built in"
    The Elsewhere streaming-availability feature now ships as part of the Jellyfin Canopy plugin, so you no longer need the standalone script. See [Discover & Request](discover.md) for how it works inside Canopy.

### Integrations Canopy works with

Jellyfin Canopy cooperates with a handful of other plugins and services. Some come highly recommended; the rest are optional but pair nicely with it.

- **[Seerr](https://github.com/seerr-team/seerr)** — the media-request management system. Canopy provides deep Seerr integration; see [Discover & Request](discover.md).
- **[File Transformation](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation)** — safe file modifications for plugins. Highly recommended for a Jellyfin Canopy install; [Getting Started](getting-started.md) covers it.
- **[Plugin Pages](https://github.com/IAmParadox27/jellyfin-plugin-pages)** — adds custom pages to the Jellyfin sidebar. Canopy can optionally use it to host its Calendar, Requests, Bookmarks, and Hidden Content pages when the corresponding `*UsePluginPages` options are enabled. By default, Canopy renders these pages natively, so Plugin Pages is not required.
- **[Custom Tabs](https://github.com/IAmParadox27/jellyfin-plugin-custom-tabs)** — custom navigation tabs for Jellyfin. Jellyfin Canopy features can be embedded in custom tabs.
- **[Kefin Tweaks](https://github.com/ranaldsgift/KefinTweaks)** — watchlist and additional tweaks that complement Canopy.

## Get involved

Contributions are welcome, whether or not you write code. You can report bugs, suggest features, add or improve translations, polish the documentation, submit code, star the repository, or help other users in discussions.

The best starting points:

- [Report issues and request features](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues)
- [Discussions](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/discussions)
- [Discord community](https://discord.gg/EYNFf7y4CG)

For the full walkthrough — how to file a good bug report, propose a feature, or contribute a translation — head to [Help & Community](help.md).

## Support the original author

If Jellyfin Canopy has improved your media experience, please support **n00bcodr**, the author of Jellyfin Enhanced. These links go to him, not to this fork's maintainer.

<div align="center">
  <a href='https://ko-fi.com/n00bcodr' target='_blank'><img height='36' style='border:0px;height:36px;' src='https://storage.ko-fi.com/cdn/kofi5.png?v=6' border='0' alt='Support n00bcodr on Ko-Fi' /></a>
  &nbsp;&nbsp;&nbsp;
  <a href="https://www.buymeacoffee.com/n00bcodr">
    <img src="https://img.buymeacoffee.com/button-api/?text=Buy me a coffee&emoji=☕&slug=n00bcodr&button_colour=FFDD00&font_colour=000000&font_family=Ubuntu&outline_colour=000000&coffee_colour=ffffff" alt="Buy Me A Coffee" />
  </a>
</div>

## License

Jellyfin Canopy is open source under the **GPL-3.0** license. The related projects listed above are also open source under GPL-3.0 unless their repository states otherwise — check each repository for its exact license terms.

---

<div align="center">

**Made with 💜 for Jellyfin and the community**

</div>
