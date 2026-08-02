using System;
using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Xunit;
using PlatformCapabilityValidation = Jellyfin.Plugin.JellyfinCanopy.Platform.PlatformActionCapabilityService.PlatformCapabilityValidation;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    public class PlatformActionCapabilityServiceTests
    {
        private static readonly DateTimeOffset Epoch =
            new(2026, 8, 3, 0, 0, 0, TimeSpan.Zero);

        private static readonly Guid UserA = Guid.Parse("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        private static readonly Guid UserB = Guid.Parse("11111111-2222-3333-4444-555555555555");
        private static readonly Guid ItemA = Guid.Parse("12345678-1234-5678-9abc-def012345678");
        private static readonly Guid ItemB = Guid.Parse("87654321-4321-8765-cba9-876543210fed");

        [Fact]
        public void MintedCapabilityIsCanonicalDeterministicAndLengthPrefixed()
        {
            var key = Enumerable.Range(0, 32).Select(value => (byte)value).ToArray();
            var nonce = Enumerable.Range(32, 32).Select(value => (byte)value).ToArray();
            var clock = new ManualTimeProvider(Epoch);
            using var first = new PlatformActionCapabilityService(clock, key, _ => nonce);
            using var second = new PlatformActionCapabilityService(clock, key, _ => nonce);
            var digest = Digest("{\"blur\":true}");

            var firstToken = Mint(first, Actor(UserA, "living|room"), SpoilerOperation, ItemA, HostItemKind.Movie, digest, true);
            var secondToken = Mint(second, Actor(UserA, "living|room"), SpoilerOperation, ItemA, HostItemKind.Movie, digest, true);

            Assert.Equal(firstToken, secondToken);
            var tokenHash = Convert.ToHexString(SHA256.HashData(Encoding.ASCII.GetBytes(firstToken)));
            Assert.Equal("E51ECBF74AB7534424391CE85555434F", tokenHash[..32]);
            Assert.Equal("488A17DAAEC6AF5AD70D2BAC719252CE", tokenHash[32..]);
            Assert.DoesNotContain('=', firstToken);
            Assert.All(firstToken, character => Assert.True(IsBase64Url(character)));
            Assert.InRange(firstToken.Length, 1, PlatformActionCapabilityService.MaximumTokenCharacters);

            var raw = Decode(firstToken);
            Assert.Equal(PlatformActionCapabilityService.AuthenticationTagBytes, raw.Length - PayloadLength(raw));
            var payload = raw.AsSpan(0, raw.Length - PlatformActionCapabilityService.AuthenticationTagBytes);
            Assert.Equal(1, payload[0]);
            Assert.Equal(UserA, new Guid(payload.Slice(1, 16), bigEndian: true));
            Assert.Equal(ItemA, new Guid(payload.Slice(17, 16), bigEndian: true));
            Assert.Equal((int)HostItemKind.Movie, BinaryPrimitives.ReadInt32BigEndian(payload.Slice(33, 4)));
            Assert.Equal(1, BinaryPrimitives.ReadInt64BigEndian(payload.Slice(37, 8)));
            Assert.Equal(1, BinaryPrimitives.ReadInt64BigEndian(payload.Slice(45, 8)));
            Assert.Equal((Epoch + PlatformActionCapabilityService.CapabilityTimeToLive).ToUnixTimeMilliseconds(),
                BinaryPrimitives.ReadInt64BigEndian(payload.Slice(53, 8)));
            Assert.Equal(nonce, payload.Slice(61, 32).ToArray());
            Assert.Equal(digest, payload.Slice(93, 32).ToArray());

            var offset = 125;
            Assert.Equal(SpoilerOperation, ReadLengthPrefixed(payload, ref offset));
            Assert.Equal("jellyfin.canopy.spoiler-guard.item-configuration.v1", ReadLengthPrefixed(payload, ref offset));
            var deviceDigest = ReadLengthPrefixedBytes(payload, ref offset);
            Assert.Equal(PlatformActionCapabilityService.AuthenticationTagBytes, deviceDigest.Length);
            Assert.Equal(-1, payload.IndexOf(Encoding.UTF8.GetBytes("living|room")));
            Assert.Equal(-1, payload.IndexOf(Encoding.UTF8.GetBytes("{\"blur\":true}")));
            Assert.Equal(payload.Length, offset);
        }

        [Fact]
        public void ExactActorOperationItemAndInputBindingsAreRechecked()
        {
            var clock = new ManualTimeProvider(Epoch);
            using var service = Service(clock);
            var digest = Digest("prepared input");
            var actor = Actor(UserA, "device-a");
            var token = Mint(service, actor, SpoilerOperation, ItemA, HostItemKind.Movie, digest, false);
            var inspection = service.Inspect(token);

            Assert.Equal(PlatformCapabilityInspectionKind.Authentic, inspection.Kind);
            Assert.Equal(PlatformCapabilityValidationKind.Valid,
                Validate(service, inspection, actor, SpoilerOperation, ItemA, HostItemKind.Movie, digest).Kind);
            Assert.Equal(PlatformCapabilityValidationKind.WrongActor,
                Validate(service, inspection, Actor(UserB, "device-a"), SpoilerOperation, ItemA, HostItemKind.Movie, digest).Kind);
            Assert.Equal(PlatformCapabilityValidationKind.WrongOperation,
                Validate(service, inspection, actor, SeerrOperation, ItemA, HostItemKind.Movie, digest).Kind);
            Assert.Equal(PlatformCapabilityValidationKind.WrongItem,
                Validate(service, inspection, actor, SpoilerOperation, ItemB, HostItemKind.Movie, digest).Kind);
            Assert.Equal(PlatformCapabilityValidationKind.WrongItem,
                Validate(service, inspection, actor, SpoilerOperation, ItemA, HostItemKind.Series, digest).Kind);
            Assert.Equal(PlatformCapabilityValidationKind.WrongInput,
                Validate(service, inspection, actor, SpoilerOperation, ItemA, HostItemKind.Movie, Digest("other input")).Kind);
            Assert.Equal(PlatformCapabilityValidationKind.WrongInput,
                Validate(service, inspection, actor, SpoilerOperation, ItemA, HostItemKind.Movie, new byte[31]).Kind);
        }

        [Fact]
        public void DeviceBindingIsOptionalOneWayAttenuationNotAnAuthoritySource()
        {
            var clock = new ManualTimeProvider(Epoch);
            using var service = Service(clock);
            var digest = Digest("input");
            var original = Actor(UserA, "device-a");

            var unbound = service.Inspect(Mint(service, original, SeerrOperation, ItemA, HostItemKind.Movie, digest, false));
            Assert.Equal(PlatformCapabilityValidationKind.Valid,
                Validate(service, unbound, Actor(UserA, "device-b"), SeerrOperation, ItemA, HostItemKind.Movie, digest).Kind);
            Assert.Equal(PlatformCapabilityValidationKind.WrongActor,
                Validate(service, unbound, Actor(UserB, "device-a"), SeerrOperation, ItemA, HostItemKind.Movie, digest).Kind);

            var bound = service.Inspect(Mint(service, original, SeerrOperation, ItemA, HostItemKind.Movie, digest, true));
            Assert.Equal(PlatformCapabilityValidationKind.Valid,
                Validate(service, bound, original, SeerrOperation, ItemA, HostItemKind.Movie, digest).Kind);
            Assert.Equal(PlatformCapabilityValidationKind.WrongDevice,
                Validate(service, bound, Actor(UserA, "device-b"), SeerrOperation, ItemA, HostItemKind.Movie, digest).Kind);
            Assert.Equal(PlatformCapabilityValidationKind.WrongDevice,
                Validate(service, bound, Actor(UserA, null), SeerrOperation, ItemA, HostItemKind.Movie, digest).Kind);

            Assert.Equal(
                PlatformCapabilityMintOutcomeKind.InvalidRequest,
                service.Mint(Actor(UserA, null), SeerrOperation, ItemA, HostItemKind.Movie, digest, true).Kind);
        }

        [Fact]
        public void DelimiterShapedAttributionCannotConfuseCanonicalClaims()
        {
            var key = Enumerable.Repeat((byte)7, 32).ToArray();
            var clock = new ManualTimeProvider(Epoch);
            var nonce = 0;
            using var service = new PlatformActionCapabilityService(
                clock,
                key,
                length => Enumerable.Repeat((byte)++nonce, length).ToArray());
            var digest = Digest("same");

            var first = Mint(service, Actor(UserA, "alpha|beta"), SpoilerOperation, ItemA, HostItemKind.Movie, digest, true);
            var second = Mint(service, Actor(UserA, "alpha"), SpoilerOperation, ItemA, HostItemKind.Movie, digest, true);

            Assert.NotEqual(first, second);
            var firstInspection = service.Inspect(first);
            var secondInspection = service.Inspect(second);
            Assert.Equal(PlatformCapabilityValidationKind.WrongDevice,
                Validate(service, firstInspection, Actor(UserA, "alpha"), SpoilerOperation, ItemA, HostItemKind.Movie, digest).Kind);
            Assert.Equal(PlatformCapabilityValidationKind.WrongDevice,
                Validate(service, secondInspection, Actor(UserA, "alpha|beta"), SpoilerOperation, ItemA, HostItemKind.Movie, digest).Kind);
        }

        [Fact]
        public void ForgedTruncatedMalformedAndNonCanonicalTokensFailClosed()
        {
            var clock = new ManualTimeProvider(Epoch);
            using var service = Service(clock);
            var token = Mint(service, Actor(UserA), HiddenOperation, ItemA, HostItemKind.Episode, Digest("input"), false);
            var tampered = token.ToCharArray();
            tampered[tampered.Length / 2] = tampered[tampered.Length / 2] == 'A' ? 'B' : 'A';

            foreach (var candidate in new string?[]
            {
                null,
                string.Empty,
                "A",
                "%%%%",
                token + "=",
                token + "\n",
                token[..^1],
                token[..20],
                new string(tampered),
                new string('A', PlatformActionCapabilityService.MaximumTokenCharacters + 1),
            })
            {
                Assert.Equal(PlatformCapabilityInspectionKind.Invalid, service.Inspect(candidate).Kind);
            }
        }

        [Fact]
        public void ExpiryBoundaryIsExactAndExpiredEntriesAreDeterministicallyReclaimed()
        {
            var clock = new ManualTimeProvider(Epoch);
            using var service = Service(clock);
            var digest = Digest("input");
            var actor = Actor(UserA);
            var token = Mint(service, actor, HiddenOperation, ItemA, HostItemKind.Series, digest, false);
            var inspection = service.Inspect(token);
            var validation = Validate(service, inspection, actor, HiddenOperation, ItemA, HostItemKind.Series, digest);

            clock.Advance(PlatformActionCapabilityService.CapabilityTimeToLive - TimeSpan.FromTicks(1));
            Assert.Equal(PlatformCapabilityValidationKind.Valid,
                Validate(service, inspection, actor, HiddenOperation, ItemA, HostItemKind.Series, digest).Kind);
            Assert.Equal(1, service.LedgerEntryCount);

            clock.Advance(TimeSpan.FromTicks(1));
            Assert.Equal(PlatformCapabilityInspectionKind.Expired, service.Inspect(token).Kind);
            Assert.Equal(PlatformCapabilityValidationKind.Expired,
                Validate(service, inspection, actor, HiddenOperation, ItemA, HostItemKind.Series, digest).Kind);
            Assert.Equal(PlatformCapabilityConsumeKind.Expired, service.Consume(validation));
            Assert.Equal(0, service.LedgerEntryCount);
        }

        [Fact]
        public void SubMillisecondMintTimeUsesTheSameCanonicalExpiryInClaimsAndLedger()
        {
            var clock = new ManualTimeProvider(Epoch.AddTicks(1));
            using var service = Service(clock);
            var actor = Actor(UserA);
            var digest = Digest("input");
            var inspection = service.Inspect(Mint(
                service,
                actor,
                HiddenOperation,
                ItemA,
                HostItemKind.Series,
                digest,
                false));
            var validation = Validate(
                service,
                inspection,
                actor,
                HiddenOperation,
                ItemA,
                HostItemKind.Series,
                digest);

            Assert.Equal(PlatformCapabilityValidationKind.Valid, validation.Kind);
            Assert.Equal(PlatformCapabilityConsumeKind.Consumed, service.Consume(validation));
        }

        [Fact]
        public void SameTimestampMintsHaveDistinctReservedNonces()
        {
            var clock = new ManualTimeProvider(Epoch);
            var counter = 0;
            using var service = new PlatformActionCapabilityService(
                clock,
                Enumerable.Repeat((byte)3, 32).ToArray(),
                length => Enumerable.Repeat((byte)++counter, length).ToArray());

            var tokens = Enumerable.Range(0, 128)
                .Select(_ => Mint(service, Actor(UserA), SpoilerOperation, ItemA, HostItemKind.Movie, Digest("input"), false))
                .ToArray();

            Assert.Equal(tokens.Length, tokens.Distinct(StringComparer.Ordinal).Count());
            Assert.Equal(tokens.Length, service.LedgerEntryCount);
            Assert.All(tokens, token => Assert.Equal(PlatformCapabilityInspectionKind.Authentic, service.Inspect(token).Kind));
        }

        [Fact]
        public async Task FirstConsumeIsAtomicAndConcurrentReuseIsReplay()
        {
            var clock = new ManualTimeProvider(Epoch);
            using var service = Service(clock);
            var actor = Actor(UserA);
            var digest = Digest("input");
            var inspection = service.Inspect(Mint(service, actor, SeerrOperation, ItemA, HostItemKind.Movie, digest, false));
            var validation = Validate(service, inspection, actor, SeerrOperation, ItemA, HostItemKind.Movie, digest);
            var outcomes = new ConcurrentBag<PlatformCapabilityConsumeKind>();

            await Task.WhenAll(Enumerable.Range(0, 64).Select(_ => Task.Run(() => outcomes.Add(service.Consume(validation)))));

            Assert.Equal(1, outcomes.Count(outcome => outcome == PlatformCapabilityConsumeKind.Consumed));
            Assert.Equal(63, outcomes.Count(outcome => outcome == PlatformCapabilityConsumeKind.Replay));
        }

        [Fact]
        public void InspectionAndCurrentValidationStaySeparateFromConsumptionForIdempotentReplay()
        {
            var clock = new ManualTimeProvider(Epoch);
            using var service = Service(clock);
            var actor = Actor(UserA);
            var digest = Digest("input");
            var token = Mint(service, actor, SeerrOperation, ItemA, HostItemKind.Movie, digest, false);

            var firstValidation = Validate(
                service,
                service.Inspect(token),
                actor,
                SeerrOperation,
                ItemA,
                HostItemKind.Movie,
                digest);
            Assert.Equal(PlatformCapabilityConsumeKind.Consumed, service.Consume(firstValidation));

            // A coordinator may return a matching stored idempotent result here without
            // calling Consume again. Authenticity and current authority still validate.
            var replayValidation = Validate(
                service,
                service.Inspect(token),
                actor,
                SeerrOperation,
                ItemA,
                HostItemKind.Movie,
                digest);
            Assert.Equal(PlatformCapabilityValidationKind.Valid, replayValidation.Kind);
            Assert.Equal(PlatformCapabilityConsumeKind.Replay, service.Consume(replayValidation));
        }

        [Fact]
        public void LedgerCapacityNeverEvictsAnUnexpiredMintedOrConsumedEntry()
        {
            var clock = new ManualTimeProvider(Epoch);
            var counter = 0;
            using var service = new PlatformActionCapabilityService(
                clock,
                Enumerable.Repeat((byte)9, 32).ToArray(),
                length => BitConverter.GetBytes(++counter).Concat(new byte[length]).Take(length).ToArray());
            var actor = Actor(UserA);
            var digest = Digest("input");
            string? firstToken = null;

            for (var index = 0; index < PlatformActionCapabilityService.MaximumLedgerEntries; index++)
            {
                var token = Mint(service, actor, SpoilerOperation, ItemA, HostItemKind.Movie, digest, false);
                firstToken ??= token;
            }

            var firstInspection = service.Inspect(firstToken);
            var firstValidation = Validate(service, firstInspection, actor, SpoilerOperation, ItemA, HostItemKind.Movie, digest);
            Assert.Equal(PlatformCapabilityConsumeKind.Consumed, service.Consume(firstValidation));
            Assert.Equal(
                PlatformCapabilityMintOutcomeKind.AtCapacity,
                service.Mint(actor, SpoilerOperation, ItemA, HostItemKind.Movie, digest, false).Kind);
            Assert.Equal(PlatformCapabilityInspectionKind.Authentic, service.Inspect(firstToken).Kind);
            Assert.Equal(PlatformCapabilityConsumeKind.Replay, service.Consume(firstValidation));
            Assert.Equal(PlatformActionCapabilityService.MaximumLedgerEntries, service.LedgerEntryCount);

            clock.Advance(PlatformActionCapabilityService.CapabilityTimeToLive);
            Assert.Equal(0, service.LedgerEntryCount);
            Assert.Equal(
                PlatformCapabilityMintOutcomeKind.Issued,
                service.Mint(actor, SpoilerOperation, ItemA, HostItemKind.Movie, digest, false).Kind);
        }

        [Fact]
        public void NonceCollisionsRetryBoundedlyAndBadEntropyFailsClosed()
        {
            var clock = new ManualTimeProvider(Epoch);
            var duplicate = Enumerable.Repeat((byte)1, 32).ToArray();
            var unique = Enumerable.Repeat((byte)2, 32).ToArray();
            var calls = 0;
            using var service = new PlatformActionCapabilityService(
                clock,
                Enumerable.Repeat((byte)8, 32).ToArray(),
                _ => ++calls <= 2 ? duplicate : unique);
            var actor = Actor(UserA);
            var digest = Digest("input");

            Assert.Equal(PlatformCapabilityMintOutcomeKind.Issued,
                service.Mint(actor, SpoilerOperation, ItemA, HostItemKind.Movie, digest, false).Kind);
            Assert.Equal(PlatformCapabilityMintOutcomeKind.Issued,
                service.Mint(actor, SpoilerOperation, ItemA, HostItemKind.Movie, digest, false).Kind);
            Assert.Equal(3, calls);

            using var wrongLength = new PlatformActionCapabilityService(clock, new byte[32], _ => new byte[31]);
            Assert.Equal(PlatformCapabilityMintOutcomeKind.EntropyUnavailable,
                wrongLength.Mint(actor, SpoilerOperation, ItemA, HostItemKind.Movie, digest, false).Kind);

            using var collisions = new PlatformActionCapabilityService(clock, new byte[32], _ => duplicate);
            Assert.Equal(PlatformCapabilityMintOutcomeKind.Issued,
                collisions.Mint(actor, SpoilerOperation, ItemA, HostItemKind.Movie, digest, false).Kind);
            Assert.Equal(PlatformCapabilityMintOutcomeKind.EntropyUnavailable,
                collisions.Mint(actor, SpoilerOperation, ItemA, HostItemKind.Movie, digest, false).Kind);
        }

        [Fact]
        public void AuthorityRevisionChangesImmediatelyInvalidateOutstandingCapabilities()
        {
            var clock = new ManualTimeProvider(Epoch);
            using var service = Service(clock);
            var actor = Actor(UserA);
            var digest = Digest("input");
            var inspection = service.Inspect(Mint(service, actor, SpoilerOperation, ItemA, HostItemKind.Movie, digest, false));
            var validation = Validate(service, inspection, actor, SpoilerOperation, ItemA, HostItemKind.Movie, digest);
            var oldRevision = service.CurrentAuthorityRevision;

            service.InvalidateOutstandingCapabilities();

            Assert.Equal(oldRevision + 1, service.CurrentAuthorityRevision);
            Assert.Equal(0, service.LedgerEntryCount);
            Assert.Equal(PlatformCapabilityValidationKind.StaleAuthority,
                Validate(service, inspection, actor, SpoilerOperation, ItemA, HostItemKind.Movie, digest).Kind);
            Assert.Equal(PlatformCapabilityConsumeKind.StaleAuthority, service.Consume(validation));
            Assert.Equal(
                PlatformCapabilityMintOutcomeKind.Issued,
                service.Mint(actor, SpoilerOperation, ItemA, HostItemKind.Movie, digest, false).Kind);
        }

        [Fact]
        public void NewProcessAuthorityRejectsOldTokensEvenAtTheSameTime()
        {
            var clock = new ManualTimeProvider(Epoch);
            using var oldProcess = new PlatformActionCapabilityService(clock, Enumerable.Repeat((byte)1, 32).ToArray(), _ => new byte[32]);
            using var newProcess = new PlatformActionCapabilityService(clock, Enumerable.Repeat((byte)2, 32).ToArray(), _ => new byte[32]);
            var token = Mint(oldProcess, Actor(UserA), SpoilerOperation, ItemA, HostItemKind.Movie, Digest("input"), false);

            Assert.Equal(PlatformCapabilityInspectionKind.Authentic, oldProcess.Inspect(token).Kind);
            Assert.Equal(PlatformCapabilityInspectionKind.Invalid, newProcess.Inspect(token).Kind);
        }

        [Fact]
        public void InspectionObjectsAreBoundToTheExactSingletonThatAuthenticatedThem()
        {
            var clock = new ManualTimeProvider(Epoch);
            var key = Enumerable.Repeat((byte)4, 32).ToArray();
            using var first = new PlatformActionCapabilityService(clock, key, _ => new byte[32]);
            using var second = new PlatformActionCapabilityService(clock, key, _ => new byte[32]);
            var actor = Actor(UserA);
            var digest = Digest("input");
            var token = Mint(first, actor, SpoilerOperation, ItemA, HostItemKind.Movie, digest, false);
            var foreignInspection = first.Inspect(token);

            Assert.Equal(PlatformCapabilityInspectionKind.Authentic, second.Inspect(token).Kind);
            Assert.Equal(
                PlatformCapabilityValidationKind.InvalidCapability,
                Validate(second, foreignInspection, actor, SpoilerOperation, ItemA, HostItemKind.Movie, digest).Kind);
        }

        [Fact]
        public void OnlyExactServiceIssuedCurrentValidationEvidenceCanConsume()
        {
            var clock = new ManualTimeProvider(Epoch);
            var key = Enumerable.Repeat((byte)4, 32).ToArray();
            using var first = new PlatformActionCapabilityService(clock, key, new SequentialNonceSource().GetBytes);
            using var second = new PlatformActionCapabilityService(clock, key, new SequentialNonceSource().GetBytes);
            var actor = Actor(UserA);
            var digest = Digest("input");
            var inspection = first.Inspect(Mint(first, actor, SpoilerOperation, ItemA, HostItemKind.Movie, digest, false));
            var valid = Validate(first, inspection, actor, SpoilerOperation, ItemA, HostItemKind.Movie, digest);
            var rejected = Validate(first, inspection, actor, SpoilerOperation, ItemA, HostItemKind.Movie, Digest("wrong"));
            var forged = new PlatformCapabilityValidation(
                PlatformCapabilityValidationKind.Valid,
                new object(),
                inspection);
            var rawAllocation = (PlatformCapabilityValidation)System.Runtime.CompilerServices.RuntimeHelpers
                .GetUninitializedObject(typeof(PlatformCapabilityValidation));

            Assert.Equal(PlatformCapabilityConsumeKind.Invalid, first.Consume(rejected));
            Assert.Equal(PlatformCapabilityConsumeKind.Invalid, first.Consume(forged));
            Assert.Equal(PlatformCapabilityConsumeKind.Invalid, first.Consume(rawAllocation));
            Assert.Equal(PlatformCapabilityConsumeKind.Invalid, second.Consume(valid));
            Assert.Equal(PlatformCapabilityConsumeKind.Consumed, first.Consume(valid));
        }

        [Fact]
        public void UnknownUnsupportedAndInvalidMintRequestsFailWithoutReservingNonce()
        {
            var clock = new ManualTimeProvider(Epoch);
            using var service = Service(clock);
            var actor = Actor(UserA);
            var digest = Digest("input");

            Assert.Equal(PlatformCapabilityMintOutcomeKind.InvalidRequest,
                service.Mint(null, SpoilerOperation, ItemA, HostItemKind.Movie, digest, false).Kind);
            Assert.Equal(PlatformCapabilityMintOutcomeKind.InvalidRequest,
                service.Mint(actor, "jellyfin.canopy.unknown", ItemA, HostItemKind.Movie, digest, false).Kind);
            Assert.Equal(PlatformCapabilityMintOutcomeKind.InvalidRequest,
                service.Mint(actor, SpoilerOperation, Guid.Empty, HostItemKind.Movie, digest, false).Kind);
            Assert.Equal(PlatformCapabilityMintOutcomeKind.InvalidRequest,
                service.Mint(actor, SpoilerOperation, ItemA, HostItemKind.Episode, digest, false).Kind);
            Assert.Equal(PlatformCapabilityMintOutcomeKind.InvalidRequest,
                service.Mint(actor, SpoilerOperation, ItemA, (HostItemKind)99, digest, false).Kind);
            Assert.Equal(PlatformCapabilityMintOutcomeKind.InvalidRequest,
                service.Mint(actor, SpoilerOperation, ItemA, HostItemKind.Movie, new byte[31], false).Kind);
            Assert.Equal(0, service.LedgerEntryCount);
        }

        [Fact]
        public void KeyIsExactly256BitsAndDisposalDestroysTheAuthority()
        {
            var clock = new ManualTimeProvider(Epoch);
            Assert.Throws<ArgumentException>(() => new PlatformActionCapabilityService(clock, new byte[31], _ => new byte[32]));
            Assert.Throws<ArgumentException>(() => new PlatformActionCapabilityService(clock, new byte[33], _ => new byte[32]));

            var service = Service(clock);
            var token = Mint(service, Actor(UserA), SpoilerOperation, ItemA, HostItemKind.Movie, Digest("input"), false);
            service.Dispose();
            service.Dispose();

            Assert.Throws<ObjectDisposedException>(() => service.Inspect(token));
            Assert.Throws<ObjectDisposedException>(() => service.Mint(
                Actor(UserA), SpoilerOperation, ItemA, HostItemKind.Movie, Digest("input"), false));
        }

        private static string SpoilerOperation => Definition(PlatformOperationFamily.SpoilerGuard).Id.Value;

        private static string HiddenOperation => Definition(PlatformOperationFamily.HiddenContent).Id.Value;

        private static string SeerrOperation => Definition(PlatformOperationFamily.Seerr).Id.Value;

        private static PlatformOperationDefinition Definition(PlatformOperationFamily family) =>
            PlatformOperationVocabulary.All.Single(definition => definition.Family == family);

        private static PlatformActionCapabilityService Service(ManualTimeProvider clock) =>
            new(clock, Enumerable.Range(1, 32).Select(value => (byte)value).ToArray(), new SequentialNonceSource().GetBytes);

        private static PlatformActor Actor(Guid userId, string? deviceId = "device-a", bool elevated = false) =>
            new(userId, elevated, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "TestClient", deviceId);

        private static byte[] Digest(string value) => SHA256.HashData(Encoding.UTF8.GetBytes(value));

        private static string Mint(
            PlatformActionCapabilityService service,
            PlatformActor actor,
            string operation,
            Guid itemId,
            HostItemKind itemKind,
            byte[] digest,
            bool deviceBound)
        {
            var outcome = service.Mint(actor, operation, itemId, itemKind, digest, deviceBound);
            Assert.Equal(PlatformCapabilityMintOutcomeKind.Issued, outcome.Kind);
            return Assert.IsType<string>(outcome.Capability);
        }

        private static PlatformCapabilityValidation Validate(
            PlatformActionCapabilityService service,
            PlatformCapabilityInspection inspection,
            PlatformActor actor,
            string operation,
            Guid itemId,
            HostItemKind itemKind,
            byte[] digest) =>
            service.ValidateCurrent(inspection, actor, operation, itemId, itemKind, digest);

        private static byte[] Decode(string value)
        {
            var base64 = value.Replace('-', '+').Replace('_', '/');
            base64 += new string('=', (4 - (base64.Length % 4)) % 4);
            return Convert.FromBase64String(base64);
        }

        private static int PayloadLength(byte[] raw) => raw.Length - PlatformActionCapabilityService.AuthenticationTagBytes;

        private static string ReadLengthPrefixed(ReadOnlySpan<byte> source, ref int offset)
        {
            var length = BinaryPrimitives.ReadUInt16BigEndian(source.Slice(offset, 2));
            offset += 2;
            var value = Encoding.UTF8.GetString(source.Slice(offset, length));
            offset += length;
            return value;
        }

        private static byte[] ReadLengthPrefixedBytes(ReadOnlySpan<byte> source, ref int offset)
        {
            var length = BinaryPrimitives.ReadUInt16BigEndian(source.Slice(offset, 2));
            offset += 2;
            var value = source.Slice(offset, length).ToArray();
            offset += length;
            return value;
        }

        private static bool IsBase64Url(char value) =>
            value is >= 'A' and <= 'Z'
            || value is >= 'a' and <= 'z'
            || value is >= '0' and <= '9'
            || value is '-' or '_';

        private sealed class ManualTimeProvider(DateTimeOffset now) : TimeProvider
        {
            public override DateTimeOffset GetUtcNow() => now;

            internal void Advance(TimeSpan amount) => now += amount;
        }

        private sealed class SequentialNonceSource
        {
            private int _value;

            internal byte[] GetBytes(int length)
            {
                var bytes = new byte[length];
                BinaryPrimitives.WriteInt32BigEndian(bytes.AsSpan(length - 4), ++_value);
                return bytes;
            }
        }
    }
}
