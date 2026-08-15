namespace Jellyfin.Plugin.JellyfinCanopy.Services.Awards
{
    public enum AwardsMediaKind
    {
        Movie,
        Series,
    }

    public enum AwardOutcome
    {
        Nomination,
        Win,
    }

    public sealed record AwardsSourceRecord(
        string WikidataId,
        AwardsMediaKind MediaKind,
        string Provider,
        string ProviderId,
        string AwardName,
        int? Year,
        AwardOutcome Outcome);

    public sealed record AwardFact(string Name, int? Year, AwardOutcome Outcome);

    public sealed record AwardsLookupResult(
        IReadOnlyList<AwardFact> Wins,
        IReadOnlyList<AwardFact> Nominations)
    {
        public static AwardsLookupResult Empty { get; } = new(
            Array.Empty<AwardFact>(),
            Array.Empty<AwardFact>());
    }

    internal sealed class AwardsIndexDocument
    {
        public int Version { get; set; }

        public bool Complete { get; set; }

        public DateTimeOffset GeneratedAtUtc { get; set; }

        public List<AwardsIndexEntry> Entries { get; set; } = new();
    }

    internal sealed class AwardsIndexEntry
    {
        public string Key { get; set; } = string.Empty;

        public string WikidataId { get; set; } = string.Empty;

        public List<AwardFact> Awards { get; set; } = new();
    }

    public sealed record AwardsSourceSnapshot(IReadOnlyList<AwardsSourceRecord> Records);

    public interface IAwardsSourceClient
    {
        Task<AwardsSourceSnapshot> FetchCompleteAsync(CancellationToken cancellationToken);
    }

    public sealed record AwardsHostIdentity(string SystemId);
}
