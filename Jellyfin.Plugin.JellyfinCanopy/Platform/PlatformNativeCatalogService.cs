using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    internal enum PlatformNativeCatalogOutcomeKind
    {
        Success,
        UnsupportedProtocol,
        NotFound,
        Unavailable,
    }

    internal sealed record PlatformNativeCatalogOutcome(
        PlatformNativeCatalogOutcomeKind Kind,
        PlatformItemDetailResolveResponse? Response = null);

    internal sealed record PlatformNativePrepareOutcome(
        PlatformNativeCatalogOutcomeKind Kind,
        PlatformActionPrepareResponse? Response = null);

    /// <summary>
    /// The fixed three-family item-detail composer. It owns all feature decisions and
    /// emits only Android's bounded native-safe allowlist.
    /// </summary>
    public sealed class PlatformNativeCatalogService
    {
        private const int MaximumResolutionAttempts = 2;

        private readonly IPlatformHost _host;
        private readonly IPluginConfigProvider _configuration;
        private readonly SpoilerGuardPlatformItemActionAdapter _spoilerGuard;
        private readonly HiddenContentPlatformItemActionAdapter _hiddenContent;
        private readonly ISeerrItemRequestPresentationOwner _seerr;
        private readonly PlatformPrepareHandleOwner _prepareHandles;
        private readonly PlatformPreparedActionContextOwner _preparedContexts;
        private readonly PlatformNativeCatalogRevisionAuthority _revisions;
        private readonly ILiveSessionRegistry _liveSessions;

        /// <summary>Initializes the fixed composer from first-party owners only.</summary>
        public PlatformNativeCatalogService(
            IPlatformHost host,
            IPluginConfigProvider configuration,
            SpoilerGuardPlatformItemActionAdapter spoilerGuard,
            HiddenContentPlatformItemActionAdapter hiddenContent,
            ISeerrItemRequestPresentationOwner seerr,
            PlatformPrepareHandleOwner prepareHandles,
            PlatformPreparedActionContextOwner preparedContexts,
            PlatformNativeCatalogRevisionAuthority revisions,
            ILiveSessionRegistry liveSessions)
        {
            _host = host ?? throw new ArgumentNullException(nameof(host));
            _configuration = configuration ?? throw new ArgumentNullException(nameof(configuration));
            _spoilerGuard = spoilerGuard ?? throw new ArgumentNullException(nameof(spoilerGuard));
            _hiddenContent = hiddenContent ?? throw new ArgumentNullException(nameof(hiddenContent));
            _seerr = seerr ?? throw new ArgumentNullException(nameof(seerr));
            _prepareHandles = prepareHandles ?? throw new ArgumentNullException(nameof(prepareHandles));
            _preparedContexts = preparedContexts ?? throw new ArgumentNullException(nameof(preparedContexts));
            _revisions = revisions ?? throw new ArgumentNullException(nameof(revisions));
            _liveSessions = liveSessions ?? throw new ArgumentNullException(nameof(liveSessions));
        }

        internal async Task<PlatformNativeCatalogOutcome> ResolveAsync(
            PlatformActor boundaryActor,
            PlatformItemDetailResolveRequest request,
            CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(boundaryActor);
            ArgumentNullException.ThrowIfNull(request);
            if (request.Protocol != PlatformConstants.ProtocolMaximum || request.SurfaceSchema != 1)
            {
                return new PlatformNativeCatalogOutcome(PlatformNativeCatalogOutcomeKind.UnsupportedProtocol);
            }

            for (var attempt = 0; attempt < MaximumResolutionAttempts; attempt++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var current = ResolveCurrent(boundaryActor, request.ItemId);
                if (current is null)
                {
                    return new PlatformNativeCatalogOutcome(PlatformNativeCatalogOutcomeKind.NotFound);
                }

                var configuration = _configuration.GetSnapshot();
                if (configuration.Configuration is null
                    || configuration.Revision < 0
                    || !configuration.Configuration.PlatformEnabled)
                {
                    return new PlatformNativeCatalogOutcome(PlatformNativeCatalogOutcomeKind.Unavailable);
                }

                var candidates = await ComposeAsync(
                    current.Actor,
                    current.Item,
                    request.Client,
                    configuration.Configuration,
                    cancellationToken).ConfigureAwait(false);

                cancellationToken.ThrowIfCancellationRequested();
                var final = ResolveCurrent(boundaryActor, request.ItemId);
                var finalConfiguration = _configuration.GetSnapshot();
                if (final is null)
                {
                    return new PlatformNativeCatalogOutcome(PlatformNativeCatalogOutcomeKind.NotFound);
                }

                if (configuration.Revision != finalConfiguration.Revision
                    || !SameActor(current.Actor, final.Actor)
                    || !SameItem(current.Item, final.Item))
                {
                    continue;
                }

                var finalCandidates = await ComposeAsync(
                    final.Actor,
                    final.Item,
                    request.Client,
                    finalConfiguration.Configuration!,
                    cancellationToken).ConfigureAwait(false);
                if (!candidates.SequenceEqual(finalCandidates))
                {
                    continue;
                }

                candidates = finalCandidates;

                var revision = _revisions.Create(SemanticProjection(
                    final.Actor,
                    final.Item,
                    request.Client,
                    configuration.Revision,
                    candidates));
                var contributions = ImmutableArray.CreateBuilder<PlatformNativeContribution>();
                foreach (var candidate in candidates)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (candidate.State is null)
                    {
                        contributions.Add(PlatformNativeContribution.Status(
                            candidate.Id,
                            candidate.Label,
                            candidate.Tone!));
                        continue;
                    }

                    var privateState = PlatformNativePreparedStateCodec.Encode(candidate.State);
                    var stateRevisions = candidate.State.Family switch
                    {
                        PlatformNativePreparedFamily.SpoilerGuard =>
                            new[] { new PlatformPrepareStateRevision("spoiler_overrides", candidate.State.ResourceRevision) },
                        PlatformNativePreparedFamily.HiddenContent =>
                            new[] { new PlatformPrepareStateRevision("hidden_items", candidate.State.ResourceRevision) },
                        _ => Array.Empty<PlatformPrepareStateRevision>(),
                    };
                    var snapshot = new PlatformPrepareSnapshot(
                        final.Actor,
                        final.Item,
                        candidate.Definition!,
                        ClientContext(request.Client),
                        stateRevisions,
                        configuration.Revision,
                        revision,
                        privateState,
                        attenuateToCurrentDevice: false);
                    var handle = _prepareHandles.IssueOrReuse(snapshot);
                    if (handle.Kind is not (PlatformPrepareHandleIssueKind.Issued or PlatformPrepareHandleIssueKind.Reused)
                        || handle.Handle is null)
                    {
                        return new PlatformNativeCatalogOutcome(PlatformNativeCatalogOutcomeKind.Unavailable);
                    }

                    contributions.Add(PlatformNativeContribution.Action(
                        candidate.Id,
                        candidate.Label,
                        candidate.Description,
                        candidate.Icon!,
                        enabled: true,
                        handle.Handle));
                }

                if (contributions.Count > PlatformNativeCatalogBounds.MaximumContributions)
                {
                    throw new InvalidOperationException("The fixed native catalog exceeded its reviewed contribution bound.");
                }

                // Registration must precede the final generation read. A concurrent
                // config save then either observes this device and sends its marker,
                // or is detected below so this attempt cannot publish stale state.
                // A raced failed attempt can leave a TTL-bound provisional entry; it
                // cannot be removed safely over a newer resolve, and remains harmless
                // because the carrier is inert and delivery requires this same user
                // to have a live session on the device.
                if (final.Actor.DeviceId is { } deviceId)
                {
                    _liveSessions.Touch(deviceId, final.Actor.UserId);
                }

                var publicationConfiguration = _configuration.GetSnapshot();
                if (publicationConfiguration.Revision != finalConfiguration.Revision
                    || publicationConfiguration.Configuration?.PlatformEnabled != true)
                {
                    continue;
                }

                return new PlatformNativeCatalogOutcome(
                    PlatformNativeCatalogOutcomeKind.Success,
                    new PlatformItemDetailResolveResponse(revision, contributions.ToImmutable()));
            }

            return new PlatformNativeCatalogOutcome(PlatformNativeCatalogOutcomeKind.Unavailable);
        }

        internal async Task<PlatformNativePrepareOutcome> PrepareAsync(
            PlatformActor boundaryActor,
            PlatformActionPrepareRequest request,
            CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(boundaryActor);
            ArgumentNullException.ThrowIfNull(request);
            cancellationToken.ThrowIfCancellationRequested();
            var snapshot = _prepareHandles.Resolve(request.PrepareHandle, boundaryActor);
            if (snapshot is null
                || !PlatformNativePreparedStateCodec.TryDecode(snapshot.PrivateState.Span, out var state))
            {
                return new PlatformNativePrepareOutcome(PlatformNativeCatalogOutcomeKind.NotFound);
            }

            var current = ResolveCurrent(boundaryActor, snapshot.Item.Id);
            var configuration = _configuration.GetSnapshot();
            if (current is null
                || configuration.Configuration is null
                || configuration.Revision != snapshot.ConfigurationRevision
                || !SameSnapshotItem(snapshot.Item, current.Item)
                || !MatchesDefinition(state, snapshot.Definition)
                || !SupportsFields(snapshot.Client, state))
            {
                return new PlatformNativePrepareOutcome(PlatformNativeCatalogOutcomeKind.NotFound);
            }

            if (!await StateRemainsCurrentAsync(
                    current.Actor,
                    current.Item,
                    state,
                    configuration.Configuration,
                    cancellationToken).ConfigureAwait(false))
            {
                return new PlatformNativePrepareOutcome(PlatformNativeCatalogOutcomeKind.NotFound);
            }

            cancellationToken.ThrowIfCancellationRequested();
            var final = ResolveCurrent(boundaryActor, snapshot.Item.Id);
            var finalConfiguration = _configuration.GetSnapshot();
            if (final is null
                || finalConfiguration.Revision != snapshot.ConfigurationRevision
                || !SameSnapshotItem(snapshot.Item, final.Item))
            {
                return new PlatformNativePrepareOutcome(PlatformNativeCatalogOutcomeKind.NotFound);
            }

            var issued = _preparedContexts.Issue(
                final.Actor,
                new PlatformPreparedActionRequest(
                    snapshot.Definition,
                    final.Item,
                    snapshot.ConfigurationRevision,
                    snapshot.PrivateState.Span),
                attenuateToCurrentDevice: false);
            if (issued.Kind != PlatformPreparedActionIssueKind.Issued
                || issued.Capability is null
                || issued.ExpiresAt is null)
            {
                return new PlatformNativePrepareOutcome(
                    issued.Kind is PlatformPreparedActionIssueKind.InvalidRequest or PlatformPreparedActionIssueKind.NotAuthorized
                        ? PlatformNativeCatalogOutcomeKind.NotFound
                        : PlatformNativeCatalogOutcomeKind.Unavailable);
            }

            var presentation = CreatePreparedPresentation(state);
            return new PlatformNativePrepareOutcome(
                PlatformNativeCatalogOutcomeKind.Success,
                new PlatformActionPrepareResponse(
                    issued.Capability,
                    issued.ExpiresAt.Value,
                    presentation.Title,
                    presentation.SubmitLabel,
                    "Cancel",
                    presentation.Fields));
        }

        private async Task<ImmutableArray<Candidate>> ComposeAsync(
            PlatformActor actor,
            HostAccessibleItem item,
            PlatformNativeClientCapabilities client,
            PluginConfiguration configuration,
            CancellationToken cancellationToken)
        {
            var candidates = ImmutableArray.CreateBuilder<Candidate>();
            if (!client.SupportsDpad)
            {
                return candidates.ToImmutable();
            }

            if (configuration.SpoilerBlurEnabled
                && item.Kind is HostItemKind.Movie or HostItemKind.Series
                && TryReadSpoiler(actor, item, out var spoiler))
            {
                if (client.SupportsContribution("status"))
                {
                    candidates.Add(Candidate.Status(
                        "spoiler-guard-status",
                        spoiler.Enabled ? "Spoiler Guard: protected" : "Spoiler Guard: unprotected",
                        spoiler.Enabled ? "positive" : "neutral"));
                }

                if (SupportsAction(client, "boolean"))
                {
                    candidates.Add(Candidate.Action(
                        "spoiler-guard-configure",
                        "Configure Spoiler Guard",
                        "Choose whether Canopy protects this item.",
                        "shield",
                        PlatformOperationDefinition.SpoilerGuardConfigureItem,
                        PlatformNativePreparedState.Spoiler(spoiler.Enabled, spoiler.OverridesRevision)));
                }
            }

            if (configuration.HiddenContentEnabled
                && item.Kind is HostItemKind.Movie or HostItemKind.Series or HostItemKind.Episode
                && TryReadHidden(actor, item, out var hidden)
                && hidden.Enabled)
            {
                if (client.SupportsContribution("status"))
                {
                    candidates.Add(Candidate.Status(
                        "hidden-content-status",
                        hidden.Hidden ? $"Hidden Content: hidden ({ScopeLabel(hidden.Scope)})" : "Hidden Content: visible",
                        hidden.Hidden ? "warning" : "neutral"));
                }

                if (SupportsAction(client, "boolean", "single_select"))
                {
                    candidates.Add(Candidate.Action(
                        "hidden-content-configure",
                        "Configure Hidden Content",
                        "Choose an exact Canopy-owned filtering scope.",
                        "visibility_off",
                        PlatformOperationDefinition.HiddenContentConfigureItem,
                        PlatformNativePreparedState.Hidden(hidden.Hidden, hidden.Scope, hidden.Revision)));
                }
            }

            if (item.Kind is HostItemKind.Movie or HostItemKind.Series)
            {
                var presentation = await ResolveSeerrPresentationAsync(
                    actor,
                    item,
                    cancellationToken).ConfigureAwait(false);
                if (presentation?.IsVisible is true)
                {
                    if (client.SupportsContribution("status"))
                    {
                        var status = SeerrStatus(presentation);
                        if (status is not null)
                        {
                            candidates.Add(Candidate.Status("seerr-status", status.Value.Label, status.Value.Tone));
                        }
                    }

                    if (SupportsAction(client, "confirmation") && presentation.StandardRequestAvailable)
                    {
                        candidates.Add(Candidate.Action(
                            "seerr-request",
                            "Request with Seerr",
                            "Canopy will re-authorize and submit this exact item.",
                            "add",
                            PlatformOperationDefinition.SeerrRequestItem,
                            PlatformNativePreparedState.Seerr(SeerrMediaRequestVariant.Standard, presentation)));
                    }

                    if (SupportsAction(client, "confirmation") && presentation.FourKRequestAvailable)
                    {
                        candidates.Add(Candidate.Action(
                            "seerr-request-4k",
                            "Request 4K with Seerr",
                            "Canopy will re-authorize and submit this exact 4K edition.",
                            "add",
                            PlatformOperationDefinition.SeerrRequestItem,
                            PlatformNativePreparedState.Seerr(SeerrMediaRequestVariant.FourK, presentation)));
                    }
                }
            }

            return candidates.ToImmutable();
        }

        private async Task<bool> StateRemainsCurrentAsync(
            PlatformActor actor,
            HostAccessibleItem item,
            PlatformNativePreparedState state,
            PluginConfiguration configuration,
            CancellationToken cancellationToken)
        {
            switch (state.Family)
            {
                case PlatformNativePreparedFamily.SpoilerGuard:
                    return configuration.SpoilerBlurEnabled
                        && TryReadSpoiler(actor, item, out var spoiler)
                        && spoiler.OverridesRevision == state.ResourceRevision
                        && spoiler.Enabled == state.CurrentBoolean;
                case PlatformNativePreparedFamily.HiddenContent:
                    return configuration.HiddenContentEnabled
                        && TryReadHiddenScope(actor, item, state.HiddenScope, out var hidden)
                        && hidden.ItemsRevision == state.ResourceRevision
                        && hidden.Hidden == state.CurrentBoolean
                        && hidden.HiddenContentEnabled;
                case PlatformNativePreparedFamily.Seerr:
                    var presentation = await ResolveSeerrPresentationAsync(
                        actor,
                        item,
                        cancellationToken).ConfigureAwait(false);
                    return presentation is not null && MatchesSeerrPresentation(state, presentation);
                default:
                    return false;
            }
        }

        private async Task<SeerrItemRequestPresentation?> ResolveSeerrPresentationAsync(
            PlatformActor actor,
            HostAccessibleItem item,
            CancellationToken cancellationToken)
        {
            try
            {
                return await _seerr.ResolveItemRequestPresentationAsync(
                    actor,
                    item,
                    cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static bool MatchesSeerrPresentation(
            PlatformNativePreparedState state,
            SeerrItemRequestPresentation presentation)
            => presentation.IsVisible
                && string.Equals(presentation.ConfigurationRevision, state.ConfigurationRevision, StringComparison.Ordinal)
                && string.Equals(presentation.UserRevision, state.UserRevision, StringComparison.Ordinal)
                && string.Equals(presentation.ItemRevision, state.ItemRevision, StringComparison.Ordinal)
                && string.Equals(presentation.ProviderRevision, state.ProviderRevision, StringComparison.Ordinal)
                && (state.SeerrVariant == SeerrMediaRequestVariant.Standard
                    ? presentation.StandardRequestAvailable
                    : presentation.FourKRequestAvailable);

        private bool TryReadSpoiler(PlatformActor actor, HostAccessibleItem item, out SpoilerGuardItemState state)
        {
            try
            {
                state = _spoilerGuard.GetState(actor, item);
                return true;
            }
            catch (Exception)
            {
                state = null!;
                return false;
            }
        }

        private bool TryReadHidden(PlatformActor actor, HostAccessibleItem item, out HiddenSnapshot snapshot)
        {
            snapshot = default;
            var scopes = new[]
            {
                HiddenContentItemScope.Global,
                HiddenContentItemScope.ContinueWatching,
                HiddenContentItemScope.NextUp,
                HiddenContentItemScope.HomeSections,
            };
            var states = new List<(HiddenContentItemScope Scope, HiddenContentItemActionResult State)>();
            foreach (var scope in scopes)
            {
                if (!TryReadHiddenScope(actor, item, scope, out var state))
                {
                    return false;
                }

                states.Add((scope, state));
            }

            if (states.Select(value => value.State.ItemsRevision).Distinct().Count() != 1
                || states.Select(value => value.State.HiddenContentEnabled).Distinct().Count() != 1)
            {
                return false;
            }

            var first = states.FirstOrDefault(value => value.State.Hidden);
            snapshot = new HiddenSnapshot(
                states.Any(value => value.State.Hidden),
                first.State is null ? HiddenContentItemScope.Global : first.Scope,
                states[0].State.ItemsRevision,
                states[0].State.HiddenContentEnabled);
            return true;
        }

        private bool TryReadHiddenScope(
            PlatformActor actor,
            HostAccessibleItem item,
            HiddenContentItemScope scope,
            out HiddenContentItemActionResult state)
        {
            try
            {
                state = _hiddenContent.GetState(actor, item, scope);
                return true;
            }
            catch (Exception)
            {
                state = null!;
                return false;
            }
        }

        private CurrentAuthority? ResolveCurrent(PlatformActor boundaryActor, Guid itemId)
        {
            var actor = PlatformActorBoundaryFilter.ReauthorizeUserActor(
                boundaryActor,
                _host);
            if (actor is null)
            {
                return null;
            }

            var access = _host.Library.FindAccessible(actor.UserId, itemId);
            return access.Item is HostAccessibleItem item
                && item.Id == itemId
                && item.Kind != HostItemKind.Other
                    ? new CurrentAuthority(actor, item)
                    : null;
        }

        private static bool SameActor(PlatformActor first, PlatformActor second)
            => first.UserId == second.UserId && first.IsElevated == second.IsElevated;

        private static bool SameItem(HostAccessibleItem first, HostAccessibleItem second)
            => first.Id == second.Id
                && first.Kind == second.Kind
                && first.SeriesId == second.SeriesId
                && first.ProviderReferences.SequenceEqual(second.ProviderReferences);

        private static bool SameSnapshotItem(
            PlatformPrepareItemSnapshot snapshot,
            HostAccessibleItem current)
        {
            try
            {
                var normalizedCurrent = new PlatformPrepareItemSnapshot(current);
                return snapshot.Id == normalizedCurrent.Id
                    && snapshot.Kind == normalizedCurrent.Kind
                    && snapshot.SeriesId == normalizedCurrent.SeriesId
                    && snapshot.ProviderReferences.SequenceEqual(normalizedCurrent.ProviderReferences);
            }
            catch (ArgumentException)
            {
                return false;
            }
        }

        private static bool SupportsAction(PlatformNativeClientCapabilities client, params string[] fields)
            => client.SupportsContribution("action")
                && fields.All(client.SupportsField);

        private static PlatformPrepareClientContext ClientContext(PlatformNativeClientCapabilities client)
            => new(
                client.ContributionKinds,
                client.FieldKinds,
                client.InputModes,
                client.Accessibility,
                client.Locale);

        private static bool MatchesDefinition(
            PlatformNativePreparedState state,
            PlatformOperationDefinition definition)
            => state.Family switch
            {
                PlatformNativePreparedFamily.SpoilerGuard =>
                    ReferenceEquals(definition, PlatformOperationDefinition.SpoilerGuardConfigureItem),
                PlatformNativePreparedFamily.HiddenContent =>
                    ReferenceEquals(definition, PlatformOperationDefinition.HiddenContentConfigureItem),
                PlatformNativePreparedFamily.Seerr =>
                    ReferenceEquals(definition, PlatformOperationDefinition.SeerrRequestItem),
                _ => false,
            };

        private static bool SupportsFields(
            PlatformPrepareClientContext client,
            PlatformNativePreparedState state)
            => client.InputModes.Contains("dpad", StringComparer.Ordinal)
                && state.Family switch
                {
                    PlatformNativePreparedFamily.SpoilerGuard =>
                        client.FieldKinds.Contains("boolean", StringComparer.Ordinal),
                    PlatformNativePreparedFamily.HiddenContent =>
                        client.FieldKinds.Contains("boolean", StringComparer.Ordinal)
                        && client.FieldKinds.Contains("single_select", StringComparer.Ordinal),
                    PlatformNativePreparedFamily.Seerr =>
                        client.FieldKinds.Contains("confirmation", StringComparer.Ordinal),
                    _ => false,
                };

        private static PreparedPresentation CreatePreparedPresentation(PlatformNativePreparedState state)
            => state.Family switch
            {
                PlatformNativePreparedFamily.SpoilerGuard => new PreparedPresentation(
                    "Configure Spoiler Guard",
                    "Apply",
                    [PlatformNativeField.Boolean(
                        "enabled",
                        "Protect this item",
                        "Canopy owns all metadata and image protection behavior.",
                        required: true,
                        state.CurrentBoolean)]),
                PlatformNativePreparedFamily.HiddenContent => new PreparedPresentation(
                    "Configure Hidden Content",
                    "Apply",
                    [
                        PlatformNativeField.Boolean(
                            "hidden",
                            "Hide this item",
                            "Canopy applies this only to the selected filtering scope.",
                            required: true,
                            state.CurrentBoolean),
                        PlatformNativeField.SingleSelect(
                            "scope",
                            "Filtering scope",
                            null,
                            required: true,
                            [
                                new PlatformNativeOption("global", "Every enabled surface"),
                                new PlatformNativeOption("continue_watching", "Continue Watching"),
                                new PlatformNativeOption("next_up", "Next Up"),
                                new PlatformNativeOption("home_sections", "Continue Watching and Next Up"),
                            ],
                            ScopeId(state.HiddenScope)),
                    ]),
                PlatformNativePreparedFamily.Seerr => new PreparedPresentation(
                    state.SeerrVariant == SeerrMediaRequestVariant.FourK ? "Request 4K with Seerr" : "Request with Seerr",
                    "Request",
                    [PlatformNativeField.Confirmation(
                        "confirm",
                        "Submit this request?",
                        "Canopy will re-check your current Jellyfin and Seerr permissions before submitting.",
                        required: true,
                        defaultChecked: false)]),
                _ => throw new InvalidOperationException("Unknown prepared family."),
            };

        private static byte[] SemanticProjection(
            PlatformActor actor,
            HostAccessibleItem item,
            PlatformNativeClientCapabilities client,
            long configurationRevision,
            ImmutableArray<Candidate> candidates)
        {
            using var stream = new MemoryStream();
            using (var writer = new Utf8JsonWriter(stream))
            {
                writer.WriteStartObject();
                writer.WriteString("User", actor.UserId.ToString("D"));
                writer.WriteBoolean("Elevated", actor.IsElevated);
                writer.WriteString("Item", item.Id.ToString("D"));
                writer.WriteNumber("Kind", (int)item.Kind);
                writer.WriteNumber("Configuration", configurationRevision);
                WriteStrings(writer, "ContributionKinds", client.ContributionKinds);
                WriteStrings(writer, "FieldKinds", client.FieldKinds);
                WriteStrings(writer, "InputModes", client.InputModes);
                WriteStrings(writer, "Accessibility", client.Accessibility);
                writer.WriteString("Locale", client.Locale);
                writer.WritePropertyName("Contributions");
                writer.WriteStartArray();
                foreach (var candidate in candidates)
                {
                    writer.WriteStartObject();
                    writer.WriteString("Id", candidate.Id);
                    writer.WriteString("Kind", candidate.State is null ? "status" : "action");
                    writer.WriteString("Label", candidate.Label);
                    if (candidate.Description is not null)
                    {
                        writer.WriteString("Description", candidate.Description);
                    }

                    if (candidate.Icon is not null)
                    {
                        writer.WriteString("Icon", candidate.Icon);
                    }

                    if (candidate.Tone is not null)
                    {
                        writer.WriteString("Tone", candidate.Tone);
                    }

                    if (candidate.State is not null)
                    {
                        writer.WriteString("Definition", candidate.Definition!.Id.Value);
                        writer.WriteBase64String("PrivateState", PlatformNativePreparedStateCodec.Encode(candidate.State));
                    }

                    writer.WriteEndObject();
                }

                writer.WriteEndArray();
                writer.WriteEndObject();
            }

            return stream.ToArray();
        }

        private static void WriteStrings(Utf8JsonWriter writer, string name, ImmutableArray<string> values)
        {
            writer.WritePropertyName(name);
            writer.WriteStartArray();
            foreach (var value in values)
            {
                writer.WriteStringValue(value);
            }

            writer.WriteEndArray();
        }

        private static (string Label, string Tone)? SeerrStatus(SeerrItemRequestPresentation presentation)
        {
            var statuses = new List<string>();
            if (presentation.StandardStatus != SeerrItemRequestStatus.Unavailable)
            {
                statuses.Add("Standard " + StatusLabel(presentation.StandardStatus));
            }

            if (presentation.FourKStatus != SeerrItemRequestStatus.Unavailable)
            {
                statuses.Add("4K " + StatusLabel(presentation.FourKStatus));
            }

            if (statuses.Count == 0)
            {
                return presentation.StandardRequestAvailable || presentation.FourKRequestAvailable
                    ? ("Seerr: available to request", "neutral")
                    : null;
            }

            var tone = presentation.StandardStatus == SeerrItemRequestStatus.Failed
                || presentation.FourKStatus == SeerrItemRequestStatus.Failed
                || presentation.StandardStatus == SeerrItemRequestStatus.Denied
                || presentation.FourKStatus == SeerrItemRequestStatus.Denied
                    ? "negative"
                    : presentation.StandardStatus == SeerrItemRequestStatus.Approved
                        || presentation.FourKStatus == SeerrItemRequestStatus.Approved
                            ? "positive"
                            : "warning";
            return ("Seerr: " + string.Join("; ", statuses), tone);
        }

        private static string StatusLabel(SeerrItemRequestStatus status) => status switch
        {
            SeerrItemRequestStatus.AlreadyRequested => "already requested",
            SeerrItemRequestStatus.Pending => "pending",
            SeerrItemRequestStatus.Approved => "approved",
            SeerrItemRequestStatus.Denied => "denied",
            SeerrItemRequestStatus.Partial => "partially available",
            SeerrItemRequestStatus.Failed => "failed",
            _ => "unavailable",
        };

        private static string ScopeId(HiddenContentItemScope scope) => scope switch
        {
            HiddenContentItemScope.Global => "global",
            HiddenContentItemScope.ContinueWatching => "continue_watching",
            HiddenContentItemScope.NextUp => "next_up",
            HiddenContentItemScope.HomeSections => "home_sections",
            _ => throw new ArgumentOutOfRangeException(nameof(scope)),
        };

        private static string ScopeLabel(HiddenContentItemScope scope) => scope switch
        {
            HiddenContentItemScope.Global => "all surfaces",
            HiddenContentItemScope.ContinueWatching => "Continue Watching",
            HiddenContentItemScope.NextUp => "Next Up",
            HiddenContentItemScope.HomeSections => "home sections",
            _ => "selected scope",
        };

        private sealed record CurrentAuthority(PlatformActor Actor, HostAccessibleItem Item);

        private readonly record struct HiddenSnapshot(bool Hidden, HiddenContentItemScope Scope, long Revision, bool Enabled);

        private sealed record PreparedPresentation(
            string Title,
            string SubmitLabel,
            ImmutableArray<PlatformNativeField> Fields);

        private sealed record Candidate(
            string Id,
            string Label,
            string? Description,
            string? Icon,
            string? Tone,
            PlatformOperationDefinition? Definition,
            PlatformNativePreparedState? State)
        {
            internal static Candidate Status(string id, string label, string tone)
                => new(id, label, null, null, tone, null, null);

            internal static Candidate Action(
                string id,
                string label,
                string description,
                string icon,
                PlatformOperationDefinition definition,
                PlatformNativePreparedState state)
                => new(id, label, description, icon, null, definition, state);
        }
    }
}
