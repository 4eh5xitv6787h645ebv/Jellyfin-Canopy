using System.Collections.Immutable;
using System.Reflection;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

public sealed class PlatformProviderInvocationContractTests
{
    [Fact]
    public void OutcomesAndPublishedShapesAreExactClosedContracts()
    {
        Assert.Equal(
            new[]
            {
                "Succeeded", "AuthorityUnavailable", "AuthorityChanged", "InvalidRequest",
                "RequestSchemaRejected", "ProviderBusy", "CallerCancelled",
                "GenerationCancelled", "DeadlineExceeded", "ProviderIgnoredCancellation",
                "ProviderFaulted", "ResponseMissing", "ResponseTooLarge",
                "ResponseInvalidJson", "ResponseEnvelopeMismatch", "ResponseSchemaRejected",
                "ResultReleaseRejected", "InvocationFailed",
            },
            Enum.GetNames<PlatformProviderInvocationStatus>());
        Assert.Equal(
            Enumerable.Range(1, 18),
            Enum.GetValues<PlatformProviderInvocationStatus>().Select(value => (int)value));

        AssertImmutable(
            typeof(PlatformProviderInvocationRequest),
            new[]
            {
                "AccessibilityHints", "CorrelationId", "DeviceAttribution", "Input", "ItemId",
                "Locale", "RemainingDeadlineMilliseconds", "Surface", "UserAttribution",
            });
        AssertImmutable(
            typeof(PlatformProviderInvocationResult),
            new[] { "Result", "Status" });
    }

    [Fact]
    public void RequestAndSuccessfulResultOwnTheirJsonAndArrayValues()
    {
        using var inputDocument = JsonDocument.Parse("{\"name\":\"Canopy\"}");
        var hints = ImmutableArray.Create("screen-reader");
        var request = new PlatformProviderInvocationRequest(
            "corr-1",
            "user-1",
            "device-1",
            Guid.Parse("11111111-2222-4333-8444-555555555555"),
            "item-detail",
            "en-AU",
            hints,
            1_000,
            inputDocument.RootElement);
        var result = PlatformProviderInvocationResult.Succeeded(request.Input);

        inputDocument.Dispose();

        Assert.Equal("Canopy", request.Input.GetProperty("name").GetString());
        Assert.Equal(new[] { "screen-reader" }, request.AccessibilityHints);
        Assert.Equal("Canopy", result.Result!.Value.GetProperty("name").GetString());
    }

    [Fact]
    public void RejectionsNeverPublishProviderPayload()
    {
        foreach (var status in Enum.GetValues<PlatformProviderInvocationStatus>()
                     .Where(value => value != PlatformProviderInvocationStatus.Succeeded))
        {
            var result = PlatformProviderInvocationResult.Rejected(status);

            Assert.Equal(status, result.Status);
            Assert.Null(result.Result);
        }
    }

    [Fact]
    public void RequestProjectionRejectsOversizedInputBeforeOwningAClone()
    {
        using var oversized = JsonDocument.Parse(
            "{\"name\":\"" + new string('x', PlatformProviderAbiContract.MaximumRequestDocumentBytes)
            + "\"}");

        var request = new PlatformProviderInvocationRequest(
            "corr-1",
            "user-1",
            "device-1",
            itemId: null,
            surface: null,
            locale: "en-AU",
            accessibilityHints: ImmutableArray<string>.Empty,
            remainingDeadlineMilliseconds: 1_000,
            oversized.RootElement);

        Assert.Equal(JsonValueKind.Undefined, request.Input.ValueKind);
    }

    private static void AssertImmutable(Type type, string[] expectedProperties)
    {
        Assert.True(type.IsSealed || type.IsValueType);
        Assert.Empty(type.GetConstructors(BindingFlags.Public | BindingFlags.Instance));
        var properties = type
            .GetProperties(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
            .OrderBy(property => property.Name, StringComparer.Ordinal)
            .ToArray();
        Assert.Equal(expectedProperties, properties.Select(property => property.Name));
        Assert.All(properties, property => Assert.False(property.CanWrite));
    }
}
