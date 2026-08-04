using System.Text.Json;

namespace JellyfinCanopy;

/// <summary>
/// Implements the independently packaged Alpha fixture's deterministic Hello operation.
/// </summary>
/// <remarks>
/// This concrete type and its method signature are a convention. The fixture deliberately
/// references no Canopy-owned runtime contract so its type remains local to this plugin's
/// collectible load context.
/// </remarks>
public sealed class ExtensionProviderEntrypoint
{
    /// <summary>The sole operation implemented by the Alpha fixture.</summary>
    public const string HelloOperationId = "org.jellyfin.canopy.conformance.hello";

    /// <summary>Invokes the fixture operation over the load-context-safe JSON ABI.</summary>
    /// <param name="operationId">The exact, case-sensitive operation identifier.</param>
    /// <param name="requestJson">The UTF-8 JSON request encoded as a CLR string.</param>
    /// <param name="cancellationToken">The caller-owned cancellation token.</param>
    /// <returns>The deterministic Hello result encoded as UTF-8 JSON in a CLR string.</returns>
    public Task<string> InvokeAsync(
        string operationId,
        string requestJson,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(operationId);
        ArgumentNullException.ThrowIfNull(requestJson);
        cancellationToken.ThrowIfCancellationRequested();

        if (!string.Equals(operationId, HelloOperationId, StringComparison.Ordinal))
        {
            throw new NotSupportedException("The requested provider operation is not supported.");
        }

        using var request = JsonDocument.Parse(requestJson);
        var root = request.RootElement;
        var correlationId = root.GetProperty("correlationId").GetString()
            ?? throw new InvalidOperationException("The request correlation id is required.");
        var protocol = root.GetProperty("protocol").GetInt32();
        var name = root.GetProperty("input").GetProperty("name").GetString()
            ?? throw new InvalidOperationException("The Hello input name is required.");
        var responseJson = JsonSerializer.Serialize(new
        {
            schemaVersion = 1,
            correlationId,
            protocol,
            result = new
            {
                message = $"Hello, {name}!",
            },
        });
        return Task.FromResult(responseJson);
    }
}
