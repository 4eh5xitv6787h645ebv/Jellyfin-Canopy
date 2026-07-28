using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Jellyfin.Plugin.Ep00Host;

/// <summary>
/// EP-00.3 — the smallest server side of the native/TV protocol that a client can be
/// written against: negotiate, fetch a filtered catalog, invoke an opaque action.
///
/// Throwaway. It exists to prove the *protocol* is implementable by a client that
/// executes no downloaded content, and to make the failure states distinguishable.
/// It is not Platform v1.
/// </summary>
public sealed class NativeSurface
{
    /// <summary>The protocol range this host speaks.</summary>
    public const int ProtocolMin = 1;

    /// <summary>The protocol range this host speaks.</summary>
    public const int ProtocolMax = 2;

    /// <summary>How long a minted action capability stays usable.</summary>
    private static readonly TimeSpan ActionLifetime = TimeSpan.FromSeconds(30);

    private readonly byte[] _signingKey = RandomNumberGenerator.GetBytes(32);
    private readonly HashSet<string> _spentActions = new(StringComparer.Ordinal);
    private readonly object _gate = new();

    /// <summary>Component kinds a client may declare. A client that omits one never receives it.</summary>
    private static readonly string[] AllComponents = ["row", "detail-action", "badge", "form"];

    /// <summary>
    /// Highest-common-version negotiation. A client declares what it can render; the
    /// host answers with what it will actually send.
    /// </summary>
    public Dictionary<string, object?> Negotiate(JsonElement request)
    {
        var clientMin = ReadInt(request, "protocolMin", 1);
        var clientMax = ReadInt(request, "protocolMax", 1);
        var components = ReadStrings(request, "components");
        var inputModes = ReadStrings(request, "inputModes");
        var locale = ReadString(request, "locale") ?? "en-US";

        var negotiated = Math.Min(clientMax, ProtocolMax);
        if (negotiated < Math.Max(clientMin, ProtocolMin))
        {
            return new Dictionary<string, object?>
            {
                ["ok"] = false,
                ["error"] = "protocol_incompatible",
                ["hostRange"] = new { min = ProtocolMin, max = ProtocolMax },
                ["clientRange"] = new { min = clientMin, max = clientMax },
                // A distinct, actionable state: not "unavailable", not "denied".
                ["detail"] = "No overlap between the client and host protocol ranges.",
            };
        }

        var supported = AllComponents.Where(components.Contains).ToArray();
        var omitted = AllComponents.Except(supported).ToArray();

        return new Dictionary<string, object?>
        {
            ["ok"] = true,
            ["protocol"] = negotiated,
            ["components"] = supported,
            // Told plainly, so a client author can see what it is missing rather than
            // wondering why a surface never appears.
            ["componentsOmitted"] = omitted,
            ["inputModes"] = inputModes.Length == 0 ? new[] { "pointer" } : inputModes,
            ["locale"] = locale,
            ["catalogRevision"] = "rev-1",
        };
    }

    /// <summary>
    /// A catalog filtered to what the client said it can render. Anything else is
    /// omitted entirely — never approximated, never half-sent.
    /// </summary>
    public Dictionary<string, object?> Catalog(JsonElement request, string userId)
    {
        var components = ReadStrings(request, "components");
        var page = Math.Max(1, ReadInt(request, "page", 1));
        var pageSize = Math.Clamp(ReadInt(request, "pageSize", 2), 1, 10);

        var all = new List<Dictionary<string, object?>>
        {
            new()
            {
                ["kind"] = "row",
                ["id"] = "ep00.row.continue",
                ["title"] = "Spike row",
                // Item references only. The client fetches and renders with its own SDK.
                ["items"] = Enumerable.Range(1, 7)
                    .Select(i => new Dictionary<string, object?>
                    {
                        ["itemId"] = "00000000000000000000000000000" + i.ToString("000", CultureInfo.InvariantCulture),
                        ["label"] = "Item " + i.ToString(CultureInfo.InvariantCulture),
                    })
                    .Skip((page - 1) * pageSize)
                    .Take(pageSize)
                    .ToArray(),
                ["page"] = page,
                ["pageSize"] = pageSize,
                ["totalItems"] = 7,
                ["hasMore"] = page * pageSize < 7,
            },
            new()
            {
                ["kind"] = "detail-action",
                ["id"] = "ep00.action.request",
                ["label"] = "Request",
                ["icon"] = "download",
                ["confirm"] = new Dictionary<string, object?>
                {
                    ["title"] = "Request this?",
                    ["confirmLabel"] = "Request",
                    ["cancelLabel"] = "Cancel",
                },
                // The client never names a provider method. It gets an opaque capability.
                ["action"] = MintAction("ep00.action.request", userId),
            },
            new()
            {
                ["kind"] = "badge",
                ["id"] = "ep00.badge.filler",
                ["label"] = "Filler",
            },
        };

        var sent = all.Where(d => components.Contains((string)d["kind"]!)).ToList();
        var omitted = all.Where(d => !components.Contains((string)d["kind"]!))
            .Select(d => new { id = d["id"], kind = d["kind"], reason = "component_not_supported_by_client" })
            .ToArray();

        return new Dictionary<string, object?>
        {
            ["catalogRevision"] = "rev-1",
            ["contributions"] = sent,
            ["omitted"] = omitted,
        };
    }

    /// <summary>
    /// Invokes an opaque action capability. Every reason for refusal is a distinct
    /// machine code, because a client has to render them differently.
    /// </summary>
    public Dictionary<string, object?> Invoke(string? token, string userId, bool simulateProviderDown)
    {
        if (string.IsNullOrWhiteSpace(token))
        {
            return Fail("action_missing", "No action capability supplied.");
        }

        // The payload is base64url-encoded before signing. An earlier version joined
        // the fields with '.' and split on it — which broke the moment an operation id
        // contained a dot ("ep00.action.request"), turning every valid capability into
        // action_malformed. A capability format must not be delimiter-sensitive to
        // values its issuer does not control.
        var parts = token.Split('.');
        if (parts.Length != 2)
        {
            return Fail("action_malformed", "Capability is not in the expected form.");
        }

        var expected = Sign(parts[0]);
        if (!CryptographicOperations.FixedTimeEquals(
                Encoding.UTF8.GetBytes(expected), Encoding.UTF8.GetBytes(parts[1])))
        {
            return Fail("action_signature_invalid", "Capability was not issued by this host.");
        }

        string[] fields;
        try
        {
            fields = Encoding.UTF8.GetString(Base64UrlDecode(parts[0])).Split('\u001f');
        }
        catch (FormatException)
        {
            return Fail("action_malformed", "Capability payload is not decodable.");
        }

        if (fields.Length != 4)
        {
            return Fail("action_malformed", "Capability payload has the wrong shape.");
        }

        if (!string.Equals(fields[1], userId, StringComparison.Ordinal))
        {
            // Bound to the user it was minted for. Replaying another user's capability
            // is a different failure from an expired one and must look different.
            return Fail("action_wrong_user", "Capability was issued to a different user.");
        }

        if (!long.TryParse(fields[2], NumberStyles.Integer, CultureInfo.InvariantCulture, out var expiresUnix)
            || DateTimeOffset.FromUnixTimeSeconds(expiresUnix) < DateTimeOffset.UtcNow)
        {
            return Fail("action_expired", "Capability has expired; fetch the catalog again.");
        }

        lock (_gate)
        {
            if (!_spentActions.Add(token))
            {
                return Fail("action_replayed", "Capability has already been used.");
            }
        }

        if (simulateProviderDown)
        {
            return Fail("provider_unavailable", "The extension behind this action is not responding.");
        }

        return new Dictionary<string, object?>
        {
            ["ok"] = true,
            ["operationId"] = fields[0],
            ["result"] = "accepted",
        };
    }

    private Dictionary<string, object?> MintAction(string operationId, string userId)
    {
        var expires = DateTimeOffset.UtcNow.Add(ActionLifetime).ToUnixTimeSeconds();
        // A per-capability nonce. Without it, two capabilities minted in the same
        // second for the same (operation, user) are byte-identical — so single-use
        // replay protection rejects the SECOND legitimate action as a replay. The
        // fixture caught exactly that.
        var nonce = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8));

        // Unit separator: not legal in an operation id, a GUID or a number, so the
        // fields cannot be confused with each other however they are named.
        var raw = string.Create(CultureInfo.InvariantCulture, $"{operationId}\u001f{userId}\u001f{expires}\u001f{nonce}");
        var payload = Base64UrlEncode(Encoding.UTF8.GetBytes(raw));
        return new Dictionary<string, object?>
        {
            ["kind"] = "opaque",
            ["capability"] = payload + "." + Sign(payload),
            ["expiresInSeconds"] = (int)ActionLifetime.TotalSeconds,
        };
    }

    private static string Base64UrlEncode(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[] Base64UrlDecode(string value)
    {
        var padded = value.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(padded.PadRight(padded.Length + ((4 - (padded.Length % 4)) % 4), '='));
    }

    private string Sign(string payload) =>
        Convert.ToHexStringLower(HMACSHA256.HashData(_signingKey, Encoding.UTF8.GetBytes(payload)));

    private static Dictionary<string, object?> Fail(string code, string detail) => new()
    {
        ["ok"] = false,
        ["error"] = code,
        ["detail"] = detail,
    };

    private static int ReadInt(JsonElement e, string name, int fallback) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.TryGetInt32(out var i)
            ? i
            : fallback;

    private static string? ReadString(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()
            : null;

    private static string[] ReadStrings(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Array
            ? v.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String).Select(x => x.GetString()!).ToArray()
            : [];
}
