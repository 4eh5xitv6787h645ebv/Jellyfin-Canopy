using System;
using System.Linq;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Microsoft.Extensions.Primitives;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    public class PlatformActionInvokeContractTests
    {
        [Fact]
        public void ExactAndroidBodyParsesThroughTheSharedIdempotencyKeyContract()
        {
            var request = Parse(
                """
                {
                  "Capability":"opaque-capability",
                  "IdempotencyKey":"9e30bb75-916e-48ac-984d-e65509cd2850",
                  "Answers":[
                    {"FieldId":"enabled","BooleanValue":true},
                    {"FieldId":"scope","OptionIds":["global"]}
                  ],
                  "FutureOptionalProperty":true
                }
                """);

            Assert.Equal("opaque-capability", request.Capability);
            Assert.Equal("9e30bb75-916e-48ac-984d-e65509cd2850", request.IdempotencyKey.Value);
            Assert.Equal(2, request.Answers.Length);
            Assert.True(request.Answers[0].BooleanValue);
            Assert.Equal(new[] { "global" }, request.Answers[1].OptionIds!.Value);
            Assert.True(PlatformActionIdempotencyCarrier.TryResolve(request, StringValues.Empty, out var key));
            Assert.Equal(request.IdempotencyKey, key);
        }

        [Theory]
        [InlineData("{}")]
        [InlineData("{\"Capability\":\"c\",\"Answers\":[]}")]
        [InlineData("{\"Capability\":\"c\",\"IdempotencyKey\":\"\",\"Answers\":[]}")]
        [InlineData("{\"Capability\":\"c\",\"IdempotencyKey\":\"space key\",\"Answers\":[]}")]
        [InlineData("{\"Capability\":\"c\",\"Capability\":\"d\",\"IdempotencyKey\":\"k\",\"Answers\":[]}")]
        [InlineData("{\"Capability\":\"c\",\"IdempotencyKey\":\"k\",\"IdempotencyKey\":\"k\",\"Answers\":[]}")]
        [InlineData("{\"Capability\":\"c\",\"IdempotencyKey\":\"k\",\"Answers\":[],\"Answers\":[]}")]
        [InlineData("{\"Capability\":\"c\",\"IdempotencyKey\":\"k\",\"Answers\":[{\"FieldId\":\"x\",\"BooleanValue\":true,\"BooleanValue\":false}]}")]
        [InlineData("{\"Capability\":\"c\",\"IdempotencyKey\":\"k\",\"Answers\":[{\"FieldId\":\"x\",\"BooleanValue\":true,\"OptionIds\":[]}]}")]
        [InlineData("{\"Capability\":\"c\",\"IdempotencyKey\":\"k\",\"Answers\":[{\"FieldId\":\"x\",\"OptionIds\":[\"a\",\"a\"]}]}")]
        public void MissingMalformedDuplicateAndAmbiguousKnownFieldsFailClosed(string json)
            => Assert.Throws<JsonException>(() => Parse(json));

        [Fact]
        public void AnswerAndOptionBoundsRejectTheExactNextElement()
        {
            var answers = string.Join(",", Enumerable.Range(0, PlatformActionInvokeRequestConverter.MaximumAnswers + 1)
                .Select(index => $"{{\"FieldId\":\"f{index}\",\"BooleanValue\":true}}"));
            Assert.Throws<JsonException>(() => Parse(Body(answers)));

            var options = string.Join(",", Enumerable.Range(0, PlatformActionInvokeRequestConverter.MaximumOptionIds + 1)
                .Select(index => $"\"o{index}\""));
            Assert.Throws<JsonException>(() => Parse(Body($"{{\"FieldId\":\"field\",\"OptionIds\":[{options}]}}")));
        }

        [Theory]
        [InlineData("")]
        [InlineData("header-key")]
        public void AnyCompetingHeaderCarrierIsRejected(string header)
        {
            var request = Parse(Body(string.Empty));
            var values = new StringValues(header);

            Assert.False(PlatformActionIdempotencyCarrier.TryResolve(request, values, out _));
        }

        [Fact]
        public void MultipleHeaderValuesAreRejectedAndBodyKeyRemainsCaseSensitive()
        {
            var request = Parse(Body(string.Empty));
            Assert.False(PlatformActionIdempotencyCarrier.TryResolve(
                request,
                new StringValues(new[] { "a", "b" }),
                out _));
            Assert.Throws<JsonException>(() => Parse(
                "{\"Capability\":\"c\",\"idempotencyKey\":\"k\",\"Answers\":[]}"));
        }

        private static PlatformActionInvokeRequest Parse(string json)
            => JsonSerializer.Deserialize<PlatformActionInvokeRequest>(json, PlatformJson.SerializerOptions)!;

        private static string Body(string answers)
            => $"{{\"Capability\":\"c\",\"IdempotencyKey\":\"key\",\"Answers\":[{answers}]}}";
    }
}
