using System;
using System.Collections.Immutable;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    internal sealed class SpoilerGuardPlatformActionPort : ISpoilerGuardPlatformActionPort
    {
        private readonly IPluginConfigProvider _configuration;
        private readonly SpoilerGuardPlatformItemActionAdapter _owner;

        public SpoilerGuardPlatformActionPort(
            IPluginConfigProvider configuration,
            SpoilerGuardPlatformItemActionAdapter owner)
        {
            _configuration = configuration ?? throw new ArgumentNullException(nameof(configuration));
            _owner = owner ?? throw new ArgumentNullException(nameof(owner));
        }

        public PlatformActionPortAdmission ValidateCurrent(
            PlatformActor actor,
            HostAccessibleItem item,
            PlatformPreparedActionContext prepared,
            ImmutableArray<PlatformActionAnswer> answers)
        {
            if (!ReferenceEquals(prepared.Definition, PlatformOperationDefinition.SpoilerGuardConfigureItem)
                || prepared.ConfigurationRevision != _configuration.ConfigurationRevision
                || _configuration.ConfigurationOrNull?.SpoilerBlurEnabled != true
                || !PlatformNativePreparedStateCodec.TryDecode(prepared.PrivateState.Span, out var state)
                || state.Family != PlatformNativePreparedFamily.SpoilerGuard
                || answers.Length != 1
                || answers[0].FieldId != "enabled"
                || answers[0].BooleanValue is not bool enabled
                || answers[0].OptionIds.HasValue)
            {
                return PlatformActionPortAdmission.Refuse(PlatformActionPortDecision.InvalidInput);
            }

            try
            {
                var current = _owner.GetState(actor, item);
                if (current.OverridesRevision != state.ResourceRevision
                    || current.Enabled != state.CurrentBoolean)
                {
                    return PlatformActionPortAdmission.Refuse(PlatformActionPortDecision.AuthorityDenied);
                }
            }
            catch (Exception)
            {
                return PlatformActionPortAdmission.Refuse(PlatformActionPortDecision.AuthorityDenied);
            }

            var input = new SpoilerInput(enabled, state.ResourceRevision);
            return PlatformActionPortAdmission.Admit(input, input.Canonical);
        }

        public Task<PlatformActionOwnerResult> InvokeAsync(
            PlatformActor actor,
            HostAccessibleItem item,
            IPlatformValidatedActionInput input,
            PlatformIdempotencyKey idempotencyKey,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (input is not SpoilerInput typed)
            {
                return Task.FromResult(Failed(PlatformErrorCode.InvalidRequest));
            }

            try
            {
                var result = _owner.Configure(
                    actor,
                    item,
                    SpoilerGuardItemConfiguration.Exact(typed.Enabled, typed.ExpectedRevision));
                return Task.FromResult(result.Outcome switch
                {
                    SpoilerGuardItemActionOutcome.Configured => Succeeded(
                        typed.Enabled ? "Spoiler Guard enabled" : "Spoiler Guard disabled",
                        "jellyfin_item",
                        "item_detail_surface"),
                    SpoilerGuardItemActionOutcome.RevisionConflict => Failed(PlatformErrorCode.Conflict),
                    SpoilerGuardItemActionOutcome.CapacityExceeded => Failed(PlatformErrorCode.RateLimited),
                    _ => Failed(PlatformErrorCode.InternalError),
                });
            }
            catch (Exception)
            {
                return Task.FromResult(Failed(PlatformErrorCode.Unavailable));
            }
        }

        private sealed class SpoilerInput : IPlatformValidatedActionInput
        {
            internal SpoilerInput(bool enabled, long expectedRevision)
            {
                Enabled = enabled;
                ExpectedRevision = expectedRevision;
                Canonical = Encoding.ASCII.GetBytes($"enabled:{(enabled ? 1 : 0)}");
            }

            internal bool Enabled { get; }

            internal long ExpectedRevision { get; }

            internal byte[] Canonical { get; }
        }

        private static PlatformActionOwnerResult Succeeded(string message, params string[] refresh)
            => PlatformNativeActionResult.Succeeded(message, refresh);

        private static PlatformActionOwnerResult Failed(string code)
            => PlatformNativeActionResult.Failed(code);
    }

    internal sealed class HiddenContentPlatformActionPort : IHiddenContentPlatformActionPort
    {
        private readonly IPluginConfigProvider _configuration;
        private readonly HiddenContentPlatformItemActionAdapter _owner;

        public HiddenContentPlatformActionPort(
            IPluginConfigProvider configuration,
            HiddenContentPlatformItemActionAdapter owner)
        {
            _configuration = configuration ?? throw new ArgumentNullException(nameof(configuration));
            _owner = owner ?? throw new ArgumentNullException(nameof(owner));
        }

        public PlatformActionPortAdmission ValidateCurrent(
            PlatformActor actor,
            HostAccessibleItem item,
            PlatformPreparedActionContext prepared,
            ImmutableArray<PlatformActionAnswer> answers)
        {
            if (!ReferenceEquals(prepared.Definition, PlatformOperationDefinition.HiddenContentConfigureItem)
                || prepared.ConfigurationRevision != _configuration.ConfigurationRevision
                || _configuration.ConfigurationOrNull?.HiddenContentEnabled != true
                || !PlatformNativePreparedStateCodec.TryDecode(prepared.PrivateState.Span, out var state)
                || state.Family != PlatformNativePreparedFamily.HiddenContent
                || answers.Length != 2
                || !TryAnswer(answers, "hidden", out var hidden)
                || !TryScope(answers, out var scope))
            {
                return PlatformActionPortAdmission.Refuse(PlatformActionPortDecision.InvalidInput);
            }

            try
            {
                var current = _owner.GetState(actor, item, scope);
                if (current.ItemsRevision != state.ResourceRevision || !current.HiddenContentEnabled)
                {
                    return PlatformActionPortAdmission.Refuse(PlatformActionPortDecision.AuthorityDenied);
                }
            }
            catch (Exception)
            {
                return PlatformActionPortAdmission.Refuse(PlatformActionPortDecision.AuthorityDenied);
            }

            var input = new HiddenInput(hidden, scope, state.ResourceRevision);
            return PlatformActionPortAdmission.Admit(input, input.Canonical);
        }

        public Task<PlatformActionOwnerResult> InvokeAsync(
            PlatformActor actor,
            HostAccessibleItem item,
            IPlatformValidatedActionInput input,
            PlatformIdempotencyKey idempotencyKey,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (input is not HiddenInput typed)
            {
                return Task.FromResult(PlatformNativeActionResult.Failed(PlatformErrorCode.InvalidRequest));
            }

            try
            {
                var result = _owner.Configure(
                    actor,
                    item,
                    HiddenContentItemConfiguration.Exact(
                        typed.Hidden,
                        typed.Scope,
                        typed.ExpectedRevision));
                return Task.FromResult(result.Outcome switch
                {
                    HiddenContentItemActionOutcome.Configured => PlatformNativeActionResult.Succeeded(
                        typed.Hidden ? "Item hidden" : "Item unhidden",
                        "jellyfin_item",
                        "item_detail_surface"),
                    HiddenContentItemActionOutcome.RevisionConflict =>
                        PlatformNativeActionResult.Failed(PlatformErrorCode.Conflict),
                    HiddenContentItemActionOutcome.CapacityExceeded =>
                        PlatformNativeActionResult.Failed(PlatformErrorCode.RateLimited),
                    HiddenContentItemActionOutcome.PayloadTooLarge =>
                        PlatformNativeActionResult.Failed(PlatformErrorCode.PayloadTooLarge),
                    _ => PlatformNativeActionResult.Failed(PlatformErrorCode.InternalError),
                });
            }
            catch (Exception)
            {
                return Task.FromResult(PlatformNativeActionResult.Failed(PlatformErrorCode.Unavailable));
            }
        }

        private static bool TryAnswer(
            ImmutableArray<PlatformActionAnswer> answers,
            string id,
            out bool value)
        {
            value = false;
            var matches = answers.Where(answer => answer.FieldId == id).ToArray();
            if (matches.Length != 1
                || matches[0].BooleanValue is not bool boolean
                || matches[0].OptionIds.HasValue)
            {
                return false;
            }

            value = boolean;
            return true;
        }

        private static bool TryScope(
            ImmutableArray<PlatformActionAnswer> answers,
            out HiddenContentItemScope scope)
        {
            scope = default;
            var matches = answers.Where(answer => answer.FieldId == "scope").ToArray();
            if (matches.Length != 1
                || matches[0].BooleanValue.HasValue
                || matches[0].OptionIds is not { } optionIds
                || optionIds.Length != 1)
            {
                return false;
            }

            return optionIds[0] switch
            {
                "global" => Set(HiddenContentItemScope.Global, out scope),
                "continue_watching" => Set(HiddenContentItemScope.ContinueWatching, out scope),
                "next_up" => Set(HiddenContentItemScope.NextUp, out scope),
                "home_sections" => Set(HiddenContentItemScope.HomeSections, out scope),
                _ => false,
            };
        }

        private static bool Set(HiddenContentItemScope value, out HiddenContentItemScope target)
        {
            target = value;
            return true;
        }

        private sealed class HiddenInput : IPlatformValidatedActionInput
        {
            internal HiddenInput(bool hidden, HiddenContentItemScope scope, long expectedRevision)
            {
                Hidden = hidden;
                Scope = scope;
                ExpectedRevision = expectedRevision;
                Canonical = Encoding.ASCII.GetBytes($"hidden:{(hidden ? 1 : 0)};scope:{(int)scope}");
            }

            internal bool Hidden { get; }

            internal HiddenContentItemScope Scope { get; }

            internal long ExpectedRevision { get; }

            internal byte[] Canonical { get; }
        }
    }

    internal sealed class SeerrPlatformActionPort : ISeerrPlatformActionPort
    {
        private readonly IPluginConfigProvider _configuration;
        private readonly ISeerrMediaRequestOwner _owner;

        public SeerrPlatformActionPort(
            IPluginConfigProvider configuration,
            ISeerrMediaRequestOwner owner)
        {
            _configuration = configuration ?? throw new ArgumentNullException(nameof(configuration));
            _owner = owner ?? throw new ArgumentNullException(nameof(owner));
        }

        public PlatformActionPortAdmission ValidateCurrent(
            PlatformActor actor,
            HostAccessibleItem item,
            PlatformPreparedActionContext prepared,
            ImmutableArray<PlatformActionAnswer> answers)
        {
            if (!ReferenceEquals(prepared.Definition, PlatformOperationDefinition.SeerrRequestItem)
                || prepared.ConfigurationRevision != _configuration.ConfigurationRevision
                || !PlatformNativePreparedStateCodec.TryDecode(prepared.PrivateState.Span, out var state)
                || state.Family != PlatformNativePreparedFamily.Seerr
                || answers.Length != 1
                || answers[0].FieldId != "confirm"
                || answers[0].BooleanValue != true
                || answers[0].OptionIds.HasValue)
            {
                return PlatformActionPortAdmission.Refuse(PlatformActionPortDecision.InvalidInput);
            }

            var input = new SeerrInput(state.SeerrVariant);
            return PlatformActionPortAdmission.Admit(input, input.Canonical);
        }

        public async Task<PlatformActionOwnerResult> InvokeAsync(
            PlatformActor actor,
            HostAccessibleItem item,
            IPlatformValidatedActionInput input,
            PlatformIdempotencyKey idempotencyKey,
            CancellationToken cancellationToken)
        {
            if (input is not SeerrInput typed)
            {
                return PlatformNativeActionResult.Failed(PlatformErrorCode.InvalidRequest);
            }

            try
            {
                var result = await _owner.RequestAsync(
                    actor,
                    item,
                    typed.Variant,
                    idempotencyKey,
                    cancellationToken).ConfigureAwait(false);
                return result.Outcome switch
                {
                    SeerrMediaRequestOutcome.Requested =>
                        PlatformNativeActionResult.Succeeded("Request submitted", "item_detail_surface"),
                    SeerrMediaRequestOutcome.AlreadyRequested =>
                        PlatformNativeActionResult.Succeeded("Already requested", "item_detail_surface"),
                    SeerrMediaRequestOutcome.AcceptedSpoilerIntentFailed =>
                        PlatformNativeActionResult.Succeeded(
                            "Request accepted; review Spoiler Guard before retrying",
                            "item_detail_surface"),
                    SeerrMediaRequestOutcome.IdentityUnavailable
                        or SeerrMediaRequestOutcome.ProviderUnavailable =>
                        PlatformNativeActionResult.Failed(PlatformErrorCode.Unavailable),
                    SeerrMediaRequestOutcome.ProviderRejected =>
                        PlatformNativeActionResult.Failed(PlatformErrorCode.Conflict),
                    SeerrMediaRequestOutcome.InvalidTarget
                        or SeerrMediaRequestOutcome.FeatureUnavailable
                        or SeerrMediaRequestOutcome.Unlinked
                        or SeerrMediaRequestOutcome.IdentityBlocked
                        or SeerrMediaRequestOutcome.IdentityChanged
                        or SeerrMediaRequestOutcome.HostAuthorizationChanged
                        or SeerrMediaRequestOutcome.PermissionDenied
                        or SeerrMediaRequestOutcome.ParentalBlocked
                        or SeerrMediaRequestOutcome.ConfigurationChanged =>
                        PlatformNativeActionResult.Failed(PlatformErrorCode.NotFound),
                    _ => PlatformNativeActionResult.Failed(PlatformErrorCode.InternalError),
                };
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception)
            {
                return PlatformNativeActionResult.Failed(PlatformErrorCode.Unavailable);
            }
        }

        private sealed class SeerrInput : IPlatformValidatedActionInput
        {
            internal SeerrInput(SeerrMediaRequestVariant variant)
            {
                Variant = variant;
                Canonical = Encoding.ASCII.GetBytes($"variant:{(int)variant};confirmed:1");
            }

            internal SeerrMediaRequestVariant Variant { get; }

            internal byte[] Canonical { get; }
        }
    }

    internal static class PlatformNativeActionResult
    {
        internal static PlatformActionOwnerResult Succeeded(string message, params string[] refreshTargets)
        {
            var value = JsonSerializer.SerializeToElement(
                new
                {
                    Outcome = "succeeded",
                    Message = new { Text = message, Tone = "positive" },
                    Refresh = new { Targets = refreshTargets },
                },
                PlatformJson.SerializerOptions);
            return PlatformActionOwnerResult.Succeeded(value);
        }

        internal static PlatformActionOwnerResult Failed(string code)
        {
            using var document = JsonDocument.Parse("{}");
            return PlatformActionOwnerResult.Failed(code, document.RootElement);
        }
    }
}
