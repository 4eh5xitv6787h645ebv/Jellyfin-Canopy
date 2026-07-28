using System.Globalization;
using System.Net.Mime;
using System.Text;
using System.Text.Json;
using MediaBrowser.Common.Api;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.Ep00Host;

/// <summary>
/// EP-00 spike surface. Every route is throwaway: it exists to produce evidence for the
/// charter, not to become Platform v1.
/// </summary>
[ApiController]
[Route("Ep00Spike")]
public class Ep00SpikeController : ControllerBase
{
    private readonly ProviderBinder _binder;
    private readonly ManifestProbe _manifests;
    private readonly LoadContextWatcher _watcher;

    public Ep00SpikeController(ProviderBinder binder, ManifestProbe manifests, LoadContextWatcher watcher)
    {
        _binder = binder;
        _manifests = manifests;
        _watcher = watcher;
    }

    /// <summary>Anonymous discovery: availability and protocol range only. No topology.</summary>
    [HttpGet("Discovery")]
    [AllowAnonymous]
    public ActionResult<object> Discovery() => Ok(new
    {
        platform = "ep00-spike",
        protocol = new { min = 1, max = 1 },
        available = true,
    });

    /// <summary>Default (any authenticated user) policy.</summary>
    [HttpGet("Whoami")]
    [Authorize]
    public ActionResult<object> Whoami() => Ok(new
    {
        claims = User.Claims.Select(c => new { c.Type, c.Value }).ToArray(),
        isAuthenticated = User.Identity?.IsAuthenticated ?? false,
    });

    /// <summary>Admin-only policy.</summary>
    [HttpGet("AdminOnly")]
    [Authorize(Policy = Policies.RequiresElevation)]
    public ActionResult<object> AdminOnly() => Ok(new { admin = true });

    [HttpGet("Self")]
    [Authorize(Policy = Policies.RequiresElevation)]
    public ActionResult<object> Self() => Ok(_binder.DescribeSelf());

    [HttpGet("Plugins")]
    [Authorize(Policy = Policies.RequiresElevation)]
    public ActionResult<object> Plugins() => Ok(_binder.EnumeratePlugins());

    [HttpGet("TypeIdentity")]
    [Authorize(Policy = Policies.RequiresElevation)]
    public ActionResult<object> TypeIdentity() => Ok(_binder.ProbeTypeIdentity());

    /// <summary>EP-00.4: what the host can still see after a runtime lifecycle change.</summary>
    [HttpGet("Runtime")]
    [Authorize(Policy = Policies.RequiresElevation)]
    public ActionResult<object> Runtime([FromQuery] bool collect) => Ok(_watcher.Snapshot(collect));

    [HttpGet("Manifests")]
    [Authorize(Policy = Policies.RequiresElevation)]
    public ActionResult<object> Manifests() => Ok(_manifests.Discover());

    [HttpGet("Traversal")]
    [Authorize(Policy = Policies.RequiresElevation)]
    public ActionResult<object> Traversal() => Ok(_manifests.ProbeTraversal());

    [HttpGet("Invoke")]
    [Authorize]
    public async Task<ActionResult<object>> Invoke(
        [FromQuery] string operationId,
        [FromQuery] string? requestJson,
        [FromQuery] int deadlineMs,
        CancellationToken cancellationToken)
    {
        var effectiveDeadline = deadlineMs <= 0 ? 2000 : Math.Min(deadlineMs, 60000);
        var result = await _binder.InvokeAsync(operationId, requestJson ?? "{}", effectiveDeadline, cancellationToken)
            .ConfigureAwait(false);
        return Ok(result);
    }

    /// <summary>
    /// Server-sent events through Jellyfin's own Kestrel/MVC pipeline. Used to establish
    /// whether an unbuffered event stream survives the host pipeline and a reverse proxy.
    /// </summary>
    [HttpGet("Stream")]
    [Authorize]
    public async Task Stream([FromQuery] int events, [FromQuery] int intervalMs, CancellationToken cancellationToken)
    {
        var total = events <= 0 ? 5 : Math.Min(events, 100);
        var interval = intervalMs <= 0 ? 250 : Math.Min(intervalMs, 5000);

        Response.StatusCode = StatusCodes.Status200OK;
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache, no-store";
        Response.Headers["X-Accel-Buffering"] = "no";

        for (var i = 0; i < total && !cancellationToken.IsCancellationRequested; i++)
        {
            var frame = string.Create(
                CultureInfo.InvariantCulture,
                $"id: {i}\nevent: ep00.tick\ndata: {{\"seq\":{i},\"utc\":\"{DateTime.UtcNow:O}\"}}\n\n");
            await Response.WriteAsync(frame, cancellationToken).ConfigureAwait(false);
            await Response.Body.FlushAsync(cancellationToken).ConfigureAwait(false);
            if (i < total - 1)
            {
                await Task.Delay(interval, cancellationToken).ConfigureAwait(false);
            }
        }
    }

    /// <summary>Bounded long-poll fallback for transports that cannot stream.</summary>
    [HttpGet("LongPoll")]
    [Authorize]
    public async Task<ActionResult<object>> LongPoll([FromQuery] int waitMs, CancellationToken cancellationToken)
    {
        var wait = waitMs <= 0 ? 1000 : Math.Min(waitMs, 30000);
        try
        {
            await Task.Delay(wait, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            return Ok(new { cancelled = true });
        }

        return Ok(new { cursor = 1, events = Array.Empty<object>(), waitedMs = wait });
    }

    /// <summary>Oversized-response probe (host side).</summary>
    [HttpGet("Big")]
    [Authorize]
    public ActionResult<object> Big([FromQuery] int bytes)
    {
        var size = bytes <= 0 ? 1024 : Math.Min(bytes, 64 * 1024 * 1024);
        var sb = new StringBuilder(size + 32);
        sb.Append('x', size);
        return Ok(new { bytes = size, blob = sb.ToString() });
    }

    /// <summary>Oversized-request probe: how large a body does the host accept before failing?</summary>
    [HttpPost("Echo")]
    [Authorize]
    [Consumes(MediaTypeNames.Application.Json)]
    public async Task<ActionResult<object>> Echo(CancellationToken cancellationToken)
    {
        using var reader = new StreamReader(Request.Body, Encoding.UTF8);
        var body = await reader.ReadToEndAsync(cancellationToken).ConfigureAwait(false);
        var depth = 0;
        try
        {
            using var doc = JsonDocument.Parse(body);
            depth = Measure(doc.RootElement, 1);
        }
        catch (JsonException ex)
        {
            return Ok(new { accepted = false, bytes = body.Length, error = ex.Message });
        }

        return Ok(new { accepted = true, bytes = body.Length, depth });
    }

    private static int Measure(JsonElement element, int depth) => element.ValueKind switch
    {
        JsonValueKind.Object => element.EnumerateObject().Select(p => Measure(p.Value, depth + 1)).DefaultIfEmpty(depth).Max(),
        JsonValueKind.Array => element.EnumerateArray().Select(e => Measure(e, depth + 1)).DefaultIfEmpty(depth).Max(),
        _ => depth,
    };
}
