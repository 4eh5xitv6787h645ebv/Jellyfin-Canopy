using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Microsoft.AspNetCore.Mvc;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class SeerrRequestOutcomeTests
{
    [Fact]
    public void CreatedResponse_IsSubmittedAndRetainsSourceStatus()
    {
        var outcome = Convert(new ContentResult
        {
            StatusCode = 201,
            ContentType = "application/json",
            Content = "{\"id\":9}",
        });

        Assert.Equal("submitted", outcome.Outcome);
        Assert.True(outcome.Submitted);
        Assert.False(outcome.Retryable);
        Assert.Equal(201, outcome.SourceStatus);
    }

    [Fact]
    public void NoAvailableSeasons_IsAlreadyRequestedInsteadOfSubmitted()
    {
        var outcome = Convert(new ContentResult
        {
            StatusCode = 202,
            Content = "{\"message\":\"No seasons available to request\"}",
        });

        Assert.Equal("already_requested", outcome.Outcome);
        Assert.False(outcome.Submitted);
    }

    [Fact]
    public void AcceptedRequestWithSpoilerIntentFailure_IsSubmittedAndNeverRetryable()
    {
        var outcome = Convert(new ObjectResult(new
        {
            error = true,
            code = "seerr_accepted_spoiler_intent_failed",
            seerrAccepted = true,
            spoilerIntentRecorded = false,
        })
        {
            StatusCode = 500,
        });

        Assert.Equal("submitted", outcome.Outcome);
        Assert.True(outcome.Submitted);
        Assert.False(outcome.Retryable);
        Assert.Equal(500, outcome.SourceStatus);
        Assert.Contains("Do not retry", outcome.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ProviderAuthenticationFailure_IsUnavailableWithoutInvitingBlindRetry()
    {
        var outcome = Convert(new ObjectResult(new
        {
            error = true,
            code = "Unauthorized",
        })
        {
            StatusCode = 401,
        });

        Assert.Equal("unavailable", outcome.Outcome);
        Assert.False(outcome.Submitted);
        Assert.False(outcome.Retryable);
        Assert.Contains("administrator", outcome.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [MemberData(nameof(AuthorizationResults))]
    public void AuthorizationResultTypes_AreDeniedWithTheirRealStatus(
        IActionResult source,
        int expectedStatus)
    {
        var outcome = Convert(source);

        Assert.Equal("denied", outcome.Outcome);
        Assert.False(outcome.Submitted);
        Assert.False(outcome.Retryable);
        Assert.Equal(expectedStatus, outcome.SourceStatus);
    }

    public static TheoryData<IActionResult, int> AuthorizationResults => new()
    {
        { new ForbidResult(), 403 },
        { new UnauthorizedResult(), 401 },
    };

    [Theory]
    [InlineData(429, "QuotaExceeded", "quota_exceeded", false)]
    [InlineData(409, "AlreadyRequested", "already_requested", false)]
    [InlineData(422, "Blocklisted", "blocked", false)]
    [InlineData(403, "Forbidden", "denied", false)]
    [InlineData(503, "unreachable", "unavailable", true)]
    [InlineData(409, "mutation_configuration_changed", "unavailable", true)]
    public void FailureResponses_MapToStableBodyIndependentOutcomes(
        int status,
        string code,
        string expected,
        bool retryable)
    {
        var outcome = Convert(new ObjectResult(new { error = true, code, message = "ignored" })
        {
            StatusCode = status,
        });

        Assert.Equal(expected, outcome.Outcome);
        Assert.False(outcome.Submitted);
        Assert.Equal(retryable, outcome.Retryable);
        Assert.Equal(status, outcome.SourceStatus);
    }

    private static SeerrRequestOutcomeResponse Convert(IActionResult source)
    {
        var result = Assert.IsType<OkObjectResult>(SeerrRequestOutcome.FromProxyResult(source));
        Assert.Equal(200, result.StatusCode);
        return Assert.IsType<SeerrRequestOutcomeResponse>(result.Value);
    }
}
