namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>Deterministic ordering for the Platform request and result pipeline.</summary>
    internal static class PlatformFilterOrder
    {
        /// <summary>Authenticate the first-party actor before inspecting caller input.</summary>
        internal const int ActorBoundary = int.MinValue;

        /// <summary>Snapshot live platform availability after actor authorization and before caller input.</summary>
        internal const int Availability = int.MinValue + 1;

        /// <summary>Reject an unacceptable response media type before inspecting the request body.</summary>
        internal const int AcceptMediaType = int.MinValue + 2;

        /// <summary>Reject an unsupported body media type before acquiring the body.</summary>
        internal const int JsonMediaType = int.MinValue + 3;

        /// <summary>Acquire and validate the bounded body only after actor and media checks.</summary>
        internal const int BoundedBody = int.MinValue + 4;

        /// <summary>Start the model-binding/action deadline after body acquisition.</summary>
        internal const int RequestLifecycle = int.MinValue + 5;

        /// <summary>Add in-band lifecycle metadata before the representation executes.</summary>
        internal const int Deprecation = int.MinValue + 6;

        /// <summary>Serialize Platform results to their exact bytes outside the deadline.</summary>
        internal const int JsonResult = int.MinValue + 7;

        /// <summary>Evaluate representation preconditions after exact serialization.</summary>
        internal const int Concurrency = int.MinValue + 8;
    }
}
