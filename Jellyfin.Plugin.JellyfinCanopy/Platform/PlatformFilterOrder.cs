namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>Deterministic ordering for the pre-model-binding Platform boundary.</summary>
    internal static class PlatformFilterOrder
    {
        /// <summary>Authenticate the first-party actor before inspecting caller input.</summary>
        internal const int ActorBoundary = int.MinValue;

        /// <summary>Reject an unsupported body media type before acquiring the body.</summary>
        internal const int JsonMediaType = int.MinValue + 1;

        /// <summary>Acquire and validate the bounded body only after actor and media checks.</summary>
        internal const int BoundedBody = int.MinValue + 2;

        /// <summary>Start the model-binding/action deadline after body acquisition.</summary>
        internal const int RequestLifecycle = int.MinValue + 3;
    }
}
