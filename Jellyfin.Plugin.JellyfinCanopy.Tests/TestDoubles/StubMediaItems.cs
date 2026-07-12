using System;
using System.Collections.Generic;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Model.Dto;
using Episode = MediaBrowser.Controller.Entities.TV.Episode;
using Season = MediaBrowser.Controller.Entities.TV.Season;
using Series = MediaBrowser.Controller.Entities.TV.Series;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;

// Test entities whose media probe returns an EMPTY result instead of throwing. A bare BaseItem's
// GetMediaSources throws in a unit-test environment (no resolver wired up); the tag cache's real
// production path gets a real — often empty — result and only treats an actual throw as a probe
// failure (keep last-good). These stubs model the production "item with no resolvable media"
// case, so BuildEntryForItem builds a normal (stream-less) entry rather than hitting the
// probe-failure/keep-last-good branch.
//
// Each overrides GetClientTypeName() so GetBaseItemKind() (which Enum.Parse-s the client type
// name) still resolves to the real kind — the default returns the runtime type name, which for a
// subclass like "StubMovie" is not a BaseItemKind and would throw.
public sealed class StubMovie : Movie
{
    public override string GetClientTypeName() => "Movie";

    public override IReadOnlyList<MediaSourceInfo> GetMediaSources(bool enablePathSubstitution) => Array.Empty<MediaSourceInfo>();
}

public sealed class StubEpisode : Episode
{
    public override string GetClientTypeName() => "Episode";

    public override IReadOnlyList<MediaSourceInfo> GetMediaSources(bool enablePathSubstitution) => Array.Empty<MediaSourceInfo>();
}

public sealed class StubSeries : Series
{
    public override string GetClientTypeName() => "Series";

    public override IReadOnlyList<MediaSourceInfo> GetMediaSources(bool enablePathSubstitution) => Array.Empty<MediaSourceInfo>();
}

public sealed class StubSeason : Season
{
    public override string GetClientTypeName() => "Season";

    public override IReadOnlyList<MediaSourceInfo> GetMediaSources(bool enablePathSubstitution) => Array.Empty<MediaSourceInfo>();
}
