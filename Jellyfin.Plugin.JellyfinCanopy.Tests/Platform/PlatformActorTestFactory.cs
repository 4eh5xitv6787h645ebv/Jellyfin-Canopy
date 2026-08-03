using System;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

/// <summary>Creates real typed-boundary user actors for downstream unit tests.</summary>
internal static class PlatformActorTestFactory
{
    internal static PlatformActor Create(
        Guid userId,
        bool isElevated,
        string correlationId,
        string? clientName,
        string? deviceId)
    {
        var boundaryResult = PlatformUserBoundaryResult.EstablishAuthenticatedUserBoundary(
            new HostUser(userId, "Test user", isElevated),
            correlationId,
            clientName,
            deviceId);
        return PlatformActorFactory.CreateAuthenticatedUserActor(boundaryResult);
    }
}
