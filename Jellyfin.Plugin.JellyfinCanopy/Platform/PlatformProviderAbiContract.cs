namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>
    /// Frozen load-context-safe provider ABI convention and envelope bounds.
    /// These values describe data only; provider discovery, binding and invocation
    /// are owned by later EP-04 slices.
    /// </summary>
    internal static class PlatformProviderAbiContract
    {
        internal const string EntrypointTypeName = "JellyfinCanopy.ExtensionProviderEntrypoint";
        internal const string InvocationMethodName = "InvokeAsync";
        internal const string InvocationSignature =
            "Task<string> InvokeAsync(string operationId, string requestJson, CancellationToken cancellationToken)";

        internal const string RequestEnvelopeSchemaId =
            "urn:jellyfin-canopy:platform:v1:provider-request-envelope";
        internal const string ResponseEnvelopeSchemaId =
            "urn:jellyfin-canopy:platform:v1:provider-response-envelope";
        internal const string ProviderSchemaResourcePrefix = "JellyfinCanopy.ProviderSchemas.";
        internal const string ProviderSchemaResourceSuffix = ".json";
        internal const int ProviderSchemaSha256Characters = 64;

        internal const int EnvelopeSchemaVersion = 1;
        internal const int MaximumRequestDocumentBytes = 64 * 1024;
        internal const int MaximumResponseDocumentBytes = 64 * 1024;
        internal const int MaximumJsonDepth = 12;
        internal const int MaximumCollectionItems = 64;
        internal const int MaximumObjectProperties = 64;
        internal const int MaximumPropertyNameBytes = 256;
        internal const int MaximumIdentifierBytes = 128;
        internal const int MaximumStringBytes = 4 * 1024;
        // The installed-provider actor ceiling contains exactly five v1 capabilities.
        // This is intentionally narrower than the process-wide capability vocabulary.
        internal const int MaximumGrantedScopes = 5;
        internal const int MaximumAccessibilityHints = 8;
        internal const int MaximumLocaleBytes = 64;
        internal const int MaximumRemainingDeadlineMilliseconds = 30_000;
    }
}
