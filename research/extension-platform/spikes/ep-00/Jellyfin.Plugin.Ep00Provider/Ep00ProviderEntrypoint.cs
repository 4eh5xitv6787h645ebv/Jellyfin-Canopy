using System.Globalization;
using System.Reflection;
using System.Runtime.Loader;
using System.Text;
using System.Text.Json;
using Ep00.Contracts;

namespace Jellyfin.Plugin.Ep00Provider;

/// <summary>
/// The convention-based provider entrypoint an EP-04 host would invoke reflectively.
/// It implements the "shared" contract interface from the provider's OWN copy of
/// SpikeContracts.dll (v2.0.0) so the host's cast to its own copy (v1.0.0) must fail.
/// </summary>
public sealed class Ep00ProviderEntrypoint : IExtensionProvider
{
    public string ProviderId => "ep00.spike.provider";

    /// <summary>Load-context-safe ABI: string in, string out, plus cancellation.</summary>
    public string Invoke(string operationId, string requestJson)
        => InvokeAsync(operationId, requestJson, CancellationToken.None).GetAwaiter().GetResult();

    public async Task<string> InvokeAsync(string operationId, string requestJson, CancellationToken cancellationToken)
    {
        switch (operationId)
        {
            case "ping":
                return JsonSerializer.Serialize(new
                {
                    ok = true,
                    providerId = ProviderId,
                    echo = requestJson,
                    contractsAssembly = typeof(IExtensionProvider).Assembly.FullName,
                    contractsLocation = typeof(IExtensionProvider).Assembly.Location,
                    loadContext = AssemblyLoadContext.GetLoadContext(typeof(Ep00ProviderEntrypoint).Assembly)?.Name,
                    contractsLoadContext = AssemblyLoadContext.GetLoadContext(typeof(IExtensionProvider).Assembly)?.Name,
                });

            case "hang":
                // Deliberately ignores cancellation for part of the wait so the host's
                // deadline/circuit-breaker behaviour can be observed against a badly
                // behaved provider.
                var hangMs = ReadInt(requestJson, "ms", 30000);
                await Task.Delay(hangMs, CancellationToken.None).ConfigureAwait(false);
                return "{\"ok\":true,\"hung\":true}";

            case "cancellable-hang":
                var cancellableMs = ReadInt(requestJson, "ms", 30000);
                await Task.Delay(cancellableMs, cancellationToken).ConfigureAwait(false);
                return "{\"ok\":true,\"hung\":true}";

            case "big":
                var bytes = ReadInt(requestJson, "bytes", 1024 * 1024);
                var sb = new StringBuilder(bytes + 32);
                sb.Append("{\"ok\":true,\"blob\":\"");
                sb.Append('x', bytes);
                sb.Append("\"}");
                return sb.ToString();

            case "throw":
                throw new InvalidOperationException("EP-00 spike: provider threw on purpose.");

            case "invalid-json":
                return "{ this is not json";

            default:
                return JsonSerializer.Serialize(new { ok = false, error = "unknown_operation", operationId });
        }
    }

    private static int ReadInt(string json, string name, int fallback)
    {
        try
        {
            using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json);
            if (doc.RootElement.ValueKind == JsonValueKind.Object
                && doc.RootElement.TryGetProperty(name, out var value)
                && value.TryGetInt32(out var parsed))
            {
                return parsed;
            }
        }
        catch (JsonException)
        {
            // fall through
        }

        return fallback;
    }

    /// <summary>Diagnostic surface used by the host spike's reflection probe.</summary>
    public static string Describe() => string.Create(
        CultureInfo.InvariantCulture,
        $"provider assembly={typeof(Ep00ProviderEntrypoint).Assembly.FullName}; alc={AssemblyLoadContext.GetLoadContext(typeof(Ep00ProviderEntrypoint).Assembly)?.Name}; contracts={typeof(IExtensionProvider).Assembly.GetName().Version}");
}
