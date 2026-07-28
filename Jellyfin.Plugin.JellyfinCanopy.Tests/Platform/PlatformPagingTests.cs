using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Microsoft.AspNetCore.Mvc;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    /// <summary>
    /// The single Platform v1 pagination dialect.
    ///
    /// The two properties that matter are that a full walk returns every row exactly
    /// once, and that a cursor which is not ours is refused rather than quietly
    /// restarting the walk — a silent restart looks like success to the client and
    /// produces duplicates without ever reporting a fault.
    /// </summary>
    public class PlatformPagingTests
    {
        private const string Scope = "extensions";

        private static PlatformCursorCodec Codec() => PlatformCursorCodec.CreateWithRandomKey();

        /// <summary>Rows with a stable, unique, ordinal-sortable key.</summary>
        private static List<string> Rows(int count) => Enumerable
            .Range(0, count)
            .Select(index => index.ToString("D6", CultureInfo.InvariantCulture))
            .ToList();

        private static List<string> Walk(List<string> rows, int pageSize, PlatformCursorCodec codec, out int pages)
        {
            var seen = new List<string>();
            string? cursor = null;
            pages = 0;

            while (true)
            {
                Assert.True(PlatformPaging.TryPaginate(rows, row => row, Scope, cursor, pageSize, codec, out var page));

                seen.AddRange(page.Items);
                pages++;

                if (page.NextCursor is null)
                {
                    return seen;
                }

                cursor = page.NextCursor;

                // A walk that never terminates would otherwise hang the suite rather than
                // fail it.
                Assert.True(pages < 1000, "The walk did not terminate.");
            }
        }

        [Theory]
        [InlineData(0, 10)]
        [InlineData(1, 10)]
        // Exactly one full page: the case where an implementation is most likely to hand
        // out a cursor that returns nothing.
        [InlineData(10, 10)]
        [InlineData(11, 10)]
        [InlineData(99, 10)]
        // Page size of one, the most cursor round-trips possible.
        [InlineData(25, 1)]
        public void AFullWalkReturnsEveryRowExactlyOnce(int rowCount, int pageSize)
        {
            var rows = Rows(rowCount);

            var seen = Walk(rows, pageSize, Codec(), out _);

            Assert.Equal(rows, seen);
            Assert.Equal(rows.Count, seen.Distinct().Count());
        }

        [Fact]
        public void TheLastPageReportsNoNextCursorRatherThanOneThatReturnsNothing()
        {
            // A cursor issued at the end would hand the client a token that yields an
            // empty page, leaving it unable to tell "more" from "done".
            Assert.True(PlatformPaging.TryPaginate(Rows(10), row => row, Scope, null, 10, Codec(), out var page));

            Assert.Equal(10, page.Items.Count);
            Assert.Null(page.NextCursor);
        }

        [Fact]
        public void AnEmptyListingIsOnePageWithNoCursor()
        {
            Assert.True(PlatformPaging.TryPaginate(Rows(0), row => row, Scope, null, 10, Codec(), out var page));

            Assert.Empty(page.Items);
            Assert.Null(page.NextCursor);
        }

        [Fact]
        public void RowsInsertedBeforeThePositionDoNotShiftTheWalk()
        {
            // The reason cursors exist. With take/skip, inserting rows behind the reader
            // slides everything down by one and the next page repeats a row.
            var rows = Rows(20);
            var codec = Codec();

            Assert.True(PlatformPaging.TryPaginate(rows, row => row, Scope, null, 10, codec, out var first));

            // Ten new rows that sort ahead of everything already returned. '!' is below
            // '0' in ordinal order, so these land behind the reader without colliding
            // with an existing key.
            var shifted = Enumerable.Range(0, 10)
                .Select(index => "!" + index.ToString("D5", CultureInfo.InvariantCulture))
                .Concat(rows)
                .OrderBy(row => row, StringComparer.Ordinal)
                .ToList();

            Assert.True(PlatformPaging.TryPaginate(shifted, row => row, Scope, first.NextCursor, 10, codec, out var second));

            // Nothing from the first page comes back, despite the collection changing.
            Assert.Empty(second.Items.Intersect(first.Items, StringComparer.Ordinal));
        }

        [Fact]
        public void AForeignCursorIsRefusedRatherThanRestartingTheWalk()
        {
            // Issued for a different listing. Under the legacy plain-base64 cursors this
            // would decode cleanly and silently produce nonsense.
            var codec = Codec();
            var foreign = codec.Encode("some-other-listing", "000005");

            Assert.False(PlatformPaging.TryPaginate(Rows(20), row => row, Scope, foreign, 10, codec, out _));
        }

        [Fact]
        public void ACursorFromAnotherServerIsRefused()
        {
            var mine = Codec();
            var theirs = Codec();

            Assert.False(PlatformPaging.TryPaginate(
                Rows(20), row => row, Scope, theirs.Encode(Scope, "000005"), 10, mine, out _));
        }

        [Theory]
        [InlineData("not-a-cursor")]
        [InlineData("")]
        [InlineData("!!!!")]
        [InlineData("AQ")]
        public void AMalformedCursorIsRefusedExceptWhenItIsSimplyAbsent(string cursor)
        {
            var expected = cursor.Length == 0;

            Assert.Equal(
                expected,
                PlatformPaging.TryPaginate(Rows(5), row => row, Scope, cursor, 10, Codec(), out _));
        }

        [Fact]
        public void ATamperedCursorIsRefused()
        {
            var codec = Codec();
            var token = codec.Encode(Scope, "000005");

            // Flip one character of the payload. Without the MAC this would decode to a
            // different, entirely plausible position.
            var tampered = token[..^1] + (token[^1] == 'A' ? 'B' : 'A');

            Assert.False(PlatformPaging.TryPaginate(Rows(20), row => row, Scope, tampered, 10, codec, out _));
        }

        [Fact]
        public void AMisorderedSourceIsRefusedRatherThanServedIncorrectly()
        {
            // The ordering requirement IS the correctness requirement: without a total
            // order, "everything after this key" is not a well-defined position and a
            // walk can skip or repeat rows.
            var reversed = Rows(10).AsEnumerable().Reverse().ToList();

            Assert.False(PlatformPaging.TryPaginate(reversed, row => row, Scope, null, 10, Codec(), out _));
        }

        [Fact]
        public void DuplicateKeysAreRefused()
        {
            // A repeated key makes "after this key" ambiguous, so a walk could skip the
            // second row or return the first one forever.
            var duplicated = new List<string> { "000001", "000002", "000002", "000003" };

            Assert.False(PlatformPaging.TryPaginate(duplicated, row => row, Scope, null, 10, Codec(), out _));
        }

        [Theory]
        [InlineData(null, PlatformPaging.DefaultPageSize)]
        [InlineData(0, PlatformPaging.DefaultPageSize)]
        [InlineData(-5, PlatformPaging.DefaultPageSize)]
        [InlineData(1, 1)]
        [InlineData(PlatformPaging.MaximumPageSize, PlatformPaging.MaximumPageSize)]
        [InlineData(PlatformPaging.MaximumPageSize + 1, PlatformPaging.MaximumPageSize)]
        [InlineData(100_000, PlatformPaging.MaximumPageSize)]
        public void PageSizeIsClampedIntoTheDocumentedRange(int? requested, int expected)
        {
            Assert.Equal(expected, PlatformPaging.NormalizePageSize(requested));
        }

        [Fact]
        public void AnOversizedRequestIsClampedRatherThanRefused()
        {
            // Clamping keeps a client working; refusing would make an honest overshoot a
            // hard failure. The maximum is documented so the client can predict it.
            Assert.True(PlatformPaging.TryPaginate(Rows(500), row => row, Scope, null, 100_000, Codec(), out var page));

            Assert.Equal(PlatformPaging.MaximumPageSize, page.Items.Count);
        }

        [Fact]
        public void CursorsCarryNoFormatAClientCouldDependOn()
        {
            // Opaque means the server can change what a cursor means. If the position
            // were readable, clients would come to depend on it and the format would
            // become a contract by accident - which is what happened to the legacy
            // base64-of-plaintext cursors.
            var token = Codec().Encode(Scope, "000005");

            Assert.DoesNotContain("000005", token, StringComparison.Ordinal);
        }

        [Fact]
        public void TheSameCursorIsStableAcrossCalls()
        {
            // A cursor that changed on every issue would defeat client-side caching and
            // make request logs unreadable, without buying anything.
            var codec = Codec();

            Assert.Equal(codec.Encode(Scope, "000005"), codec.Encode(Scope, "000005"));
        }

        [Fact]
        public void ARoundTripRecoversThePositionExactly()
        {
            var codec = Codec();

            Assert.True(codec.TryDecode(Scope, codec.Encode(Scope, "a\0weird/position+value"), out var position));
            Assert.Equal("a\0weird/position+value", position);
        }

        [Fact]
        public void TheScopeIsLengthPrefixedSoCursorsCannotCrossListings()
        {
            // Without a length prefix, ("ab", "c") and ("a", "bc") sign the same bytes and
            // a cursor from one listing verifies against another.
            var codec = Codec();

            Assert.False(codec.TryDecode("a", codec.Encode("ab", "c"), out _));
            Assert.False(codec.TryDecode("ab", codec.Encode("a", "bc"), out _));
        }

        [Fact]
        public void AWeakSigningKeyIsRefused()
        {
            Assert.Throws<ArgumentException>(() => new PlatformCursorCodec(new byte[16]));
        }

        [Fact]
        public void ThePlatformSurfaceExposesNoOffsetPagingParameters()
        {
            // take/skip and page/size are explicitly not carried into the platform. This
            // fails if one reappears on a platform action, which is how three dialects
            // grew on the legacy surface in the first place.
            var offsetNames = new[] { "take", "skip", "page", "pagesize", "size", "offset", "start", "limit" };

            var offenders = typeof(PlatformControllerBase).Assembly
                .GetTypes()
                .Where(type => !type.IsAbstract && typeof(PlatformControllerBase).IsAssignableFrom(type))
                .SelectMany(type => type.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
                .Where(method => !method.IsSpecialName)
                .SelectMany(method => method.GetParameters().Select(parameter => (method, parameter)))
                .Where(pair => offsetNames.Contains(pair.parameter.Name?.ToLowerInvariant()))
                .Select(pair => $"{pair.method.DeclaringType!.Name}.{pair.method.Name}({pair.parameter.Name})")
                .ToList();

            Assert.True(
                offenders.Count == 0,
                "Platform v1 speaks one pagination dialect - opaque forward cursors. These actions take "
                + "offset-style parameters instead: " + string.Join(", ", offenders));
        }
    }
}
