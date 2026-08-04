using System;
using System.Reflection;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>Closed, redaction-safe outcomes for lazy provider binding.</summary>
    internal enum PlatformProviderBindingStatus
    {
        Bound = 1,
        AuthorityUnavailable = 2,
        OperationUnavailable = 3,
        ProtocolUnsupported = 4,
        GrantInsufficient = 5,
        ProviderAbsent = 6,
        ProviderNotActive = 7,
        HostIdentityChanged = 8,
        ProviderInstanceUnavailable = 9,
        EntrypointMissing = 10,
        AbiMismatch = 11,
        ServiceUnavailable = 12,
        ServiceResolutionFailed = 13,
        SchemaMissing = 14,
        SchemaResourceAmbiguous = 15,
        SchemaReadFailed = 16,
        SchemaTooLarge = 17,
        SchemaHashMismatch = 18,
        SchemaInvalidUtf8 = 19,
        SchemaInvalidJson = 20,
        SchemaBoundsExceeded = 21,
        SchemaIdentityMismatch = 22,
        SchemaDialectUnsupported = 23,
        SchemaExternalReference = 24,
        SchemaVocabularyUnsupported = 25,
        AuthorityChanged = 26,
        BindingFailed = 27,
    }

    /// <summary>
    /// One ephemeral pre-invocation binding. It proves only that exact registry, host,
    /// ABI and embedded-schema checks agreed during this bind. A later invocation owner
    /// must acquire and revalidate its own bounded authority/release leases.
    /// </summary>
    internal sealed class PlatformProviderBoundOperation
    {
        internal PlatformProviderBoundOperation(
            PlatformProviderOperationBindingClaim claim,
            PlatformProviderForeignEntrypoint entrypoint,
            PlatformProviderEmbeddedSchemaPair schemas)
        {
            ArgumentNullException.ThrowIfNull(claim);
            ArgumentNullException.ThrowIfNull(entrypoint);
            ArgumentNullException.ThrowIfNull(schemas);
            Claim = claim;
            Entrypoint = entrypoint;
            Schemas = schemas;
        }

        internal PlatformProviderOperationBindingClaim Claim { get; }

        internal PlatformProviderForeignEntrypoint Entrypoint { get; }

        internal PlatformProviderEmbeddedSchemaPair Schemas { get; }
    }

    /// <summary>One atomic provider-binding result; failures never publish partial state.</summary>
    internal readonly record struct PlatformProviderBindingResult
    {
        private PlatformProviderBindingResult(
            PlatformProviderBindingStatus status,
            PlatformProviderBoundOperation? binding)
        {
            if (!Enum.IsDefined(status)
                || (status == PlatformProviderBindingStatus.Bound) != (binding is not null))
            {
                throw new ArgumentException("The provider binding result is inconsistent.", nameof(status));
            }

            Status = status;
            Binding = binding;
        }

        internal PlatformProviderBindingStatus Status { get; }

        internal PlatformProviderBoundOperation? Binding { get; }

        internal static PlatformProviderBindingResult Bound(PlatformProviderBoundOperation binding) =>
            new(PlatformProviderBindingStatus.Bound, binding);

        internal static PlatformProviderBindingResult Rejected(PlatformProviderBindingStatus status) =>
            new(status, null);
    }

    /// <summary>
    /// Coordinates exact registry admission, lazy Jellyfin binding and embedded-schema
    /// admission. It deliberately contains no provider invocation, cache, timer or route.
    /// </summary>
    internal sealed class PlatformProviderBindingService
    {
        private readonly Lazy<PlatformProviderRegistry> _registry;
        private readonly IPlatformProviderBindingHost _host;
        private readonly Func<Assembly, string, string, string, string,
            PlatformProviderEmbeddedSchemaAdmissionResult> _admitSchemas;

        internal PlatformProviderBindingService(
            Lazy<PlatformProviderRegistry> registry,
            IPlatformProviderBindingHost host)
            : this(registry, host, PlatformProviderEmbeddedSchemaAdmission.Admit)
        {
        }

        internal PlatformProviderBindingService(
            Lazy<PlatformProviderRegistry> registry,
            IPlatformProviderBindingHost host,
            Func<Assembly, string, string, string, string,
                PlatformProviderEmbeddedSchemaAdmissionResult> admitSchemas)
        {
            ArgumentNullException.ThrowIfNull(registry);
            ArgumentNullException.ThrowIfNull(host);
            ArgumentNullException.ThrowIfNull(admitSchemas);
            _registry = registry;
            _host = host;
            _admitSchemas = admitSchemas;
        }

        internal PlatformProviderBindingResult Bind(
            Guid pluginId,
            string operationId,
            int negotiatedProtocol)
        {
            PlatformProviderRegistry registry;
            PlatformProviderOperationBindingClaimResult claimResult;
            try
            {
                registry = _registry.Value;
                claimResult = registry.ClaimOperationBinding(
                    pluginId,
                    operationId,
                    negotiatedProtocol);
            }
            catch (Exception)
            {
                return Rejected(PlatformProviderBindingStatus.BindingFailed);
            }

            if (claimResult.Status != PlatformProviderOperationBindingClaimStatus.Claimed
                || claimResult.Claim is null)
            {
                return Rejected(Map(claimResult.Status));
            }

            var claim = claimResult.Claim;
            var hostRequest = new PlatformProviderHostBindingRequest(
                claim.PluginId,
                claim.HostVersion);
            PlatformProviderHostBindingResult hostResult;
            try
            {
                hostResult = _host.Bind(hostRequest);
            }
            catch (Exception)
            {
                return Rejected(PlatformProviderBindingStatus.BindingFailed);
            }

            if (hostResult.Status != PlatformProviderHostBindingStatus.Bound
                || hostResult.Binding is null)
            {
                return Rejected(Map(hostResult.Status));
            }

            if (!registry.RevalidateOperationBindingClaim(claim))
            {
                return Rejected(PlatformProviderBindingStatus.AuthorityChanged);
            }

            var operation = claim.Operation;
            PlatformProviderEmbeddedSchemaAdmissionResult schemas;
            try
            {
                schemas = _admitSchemas(
                    hostResult.Binding.Assembly,
                    operation.RequestSchemaId,
                    operation.RequestSchemaSha256,
                    operation.ResponseSchemaId,
                    operation.ResponseSchemaSha256);
            }
            catch (Exception)
            {
                return Rejected(PlatformProviderBindingStatus.BindingFailed);
            }
            if (schemas.Status != PlatformProviderEmbeddedSchemaAdmissionStatus.Admitted
                || schemas.Schemas is null)
            {
                return Rejected(Map(schemas.Status));
            }

            PlatformProviderHostBindingStatus hostRevalidation;
            try
            {
                hostRevalidation = _host.Revalidate(hostRequest, hostResult.Binding);
            }
            catch (Exception)
            {
                return Rejected(PlatformProviderBindingStatus.BindingFailed);
            }

            if (hostRevalidation != PlatformProviderHostBindingStatus.Bound)
            {
                return Rejected(Map(hostRevalidation));
            }

            if (!registry.RevalidateOperationBindingClaim(claim))
            {
                return Rejected(PlatformProviderBindingStatus.AuthorityChanged);
            }

            return PlatformProviderBindingResult.Bound(
                new PlatformProviderBoundOperation(
                    claim,
                    hostResult.Binding,
                    schemas.Schemas));
        }

        private static PlatformProviderBindingStatus Map(
            PlatformProviderOperationBindingClaimStatus status) => status switch
            {
                PlatformProviderOperationBindingClaimStatus.AuthorityUnavailable =>
                    PlatformProviderBindingStatus.AuthorityUnavailable,
                PlatformProviderOperationBindingClaimStatus.OperationUnavailable =>
                    PlatformProviderBindingStatus.OperationUnavailable,
                PlatformProviderOperationBindingClaimStatus.ProtocolUnsupported =>
                    PlatformProviderBindingStatus.ProtocolUnsupported,
                PlatformProviderOperationBindingClaimStatus.GrantInsufficient =>
                    PlatformProviderBindingStatus.GrantInsufficient,
                _ => PlatformProviderBindingStatus.BindingFailed,
            };

        private static PlatformProviderBindingStatus Map(
            PlatformProviderHostBindingStatus status) => status switch
            {
                PlatformProviderHostBindingStatus.ProviderAbsent => PlatformProviderBindingStatus.ProviderAbsent,
                PlatformProviderHostBindingStatus.ProviderNotActive => PlatformProviderBindingStatus.ProviderNotActive,
                PlatformProviderHostBindingStatus.HostIdentityChanged => PlatformProviderBindingStatus.HostIdentityChanged,
                PlatformProviderHostBindingStatus.ProviderInstanceUnavailable =>
                    PlatformProviderBindingStatus.ProviderInstanceUnavailable,
                PlatformProviderHostBindingStatus.EntrypointMissing => PlatformProviderBindingStatus.EntrypointMissing,
                PlatformProviderHostBindingStatus.AbiMismatch => PlatformProviderBindingStatus.AbiMismatch,
                PlatformProviderHostBindingStatus.ServiceUnavailable => PlatformProviderBindingStatus.ServiceUnavailable,
                PlatformProviderHostBindingStatus.ServiceResolutionFailed =>
                    PlatformProviderBindingStatus.ServiceResolutionFailed,
                _ => PlatformProviderBindingStatus.BindingFailed,
            };

        private static PlatformProviderBindingStatus Map(
            PlatformProviderEmbeddedSchemaAdmissionStatus status) => status switch
            {
                PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaMissing => PlatformProviderBindingStatus.SchemaMissing,
                PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaResourceAmbiguous =>
                    PlatformProviderBindingStatus.SchemaResourceAmbiguous,
                PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaReadFailed =>
                    PlatformProviderBindingStatus.SchemaReadFailed,
                PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaTooLarge => PlatformProviderBindingStatus.SchemaTooLarge,
                PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaHashMismatch =>
                    PlatformProviderBindingStatus.SchemaHashMismatch,
                PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaInvalidUtf8 =>
                    PlatformProviderBindingStatus.SchemaInvalidUtf8,
                PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaInvalidJson =>
                    PlatformProviderBindingStatus.SchemaInvalidJson,
                PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaBoundsExceeded =>
                    PlatformProviderBindingStatus.SchemaBoundsExceeded,
                PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaIdentityMismatch =>
                    PlatformProviderBindingStatus.SchemaIdentityMismatch,
                PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaDialectUnsupported =>
                    PlatformProviderBindingStatus.SchemaDialectUnsupported,
                PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaExternalReference =>
                    PlatformProviderBindingStatus.SchemaExternalReference,
                PlatformProviderEmbeddedSchemaAdmissionStatus.SchemaVocabularyUnsupported =>
                    PlatformProviderBindingStatus.SchemaVocabularyUnsupported,
                _ => PlatformProviderBindingStatus.BindingFailed,
            };

        private static PlatformProviderBindingResult Rejected(PlatformProviderBindingStatus status) =>
            PlatformProviderBindingResult.Rejected(status);
    }
}
