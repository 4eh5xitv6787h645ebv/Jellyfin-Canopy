using System.Diagnostics;
using System.Globalization;

namespace Jellyfin.Plugin.Ep00Host;

/// <summary>
/// EP-00.5. Demonstrates that "validate the path, then open it" is exploitable, and
/// that "open it, then validate the descriptor" is not.
///
/// The race is real rather than theoretical: an extension can replace a file inside
/// its own plugin directory at any moment, and the kernel reads manifests from that
/// directory on a schedule it does not control.
/// </summary>
public sealed class ToctouProbe
{
    private const string ScratchRoot = "/config/ep00-toctou";
    private const string TargetName = "target.json";
    private const string HonestContents = "{\"honest\":true}";

    /// <summary>Something outside the root that is readable and unmistakable.</summary>
    private const string SecretPath = "/etc/hostname";

    public Dictionary<string, object?> Run(int iterations)
    {
        var rounds = Math.Clamp(iterations, 1, 20000);
        var target = Path.Combine(ScratchRoot, TargetName);

        Directory.CreateDirectory(ScratchRoot);
        ResetToHonestFile(target);

        var result = new Dictionary<string, object?>
        {
            ["iterations"] = rounds,
            ["root"] = ScratchRoot,
        };

        using var swapping = new CancellationTokenSource();
        var swaps = 0L;
        var swapper = Task.Run(
            () =>
            {
                while (!swapping.IsCancellationRequested)
                {
                    try
                    {
                        // Alternate between an honest file and a link pointing outside
                        // the root, as fast as the filesystem allows.
                        File.Delete(target);
                        File.CreateSymbolicLink(target, SecretPath);
                        Interlocked.Increment(ref swaps);
                        File.Delete(target);
                        File.WriteAllText(target, HonestContents);
                        Interlocked.Increment(ref swaps);
                    }
                    catch (IOException)
                    {
                        // Losing a race against the reader is expected; keep going.
                    }
                    catch (UnauthorizedAccessException)
                    {
                    }
                }
            },
            CancellationToken.None);

        // The honest file is rewritten by the swapper, and WriteAllText truncates
        // before it writes — so a reader can legitimately observe an empty or partial
        // file. That is a TORN read, not a containment failure, and conflating the two
        // would make the fix look broken. A leak is only a read whose contents match
        // the file OUTSIDE the root.
        var secret = string.Empty;
        try
        {
            secret = File.ReadAllText(SecretPath).Trim();
        }
        catch (IOException)
        {
        }

        var naiveLeaks = 0;
        var naiveTorn = 0;
        var naiveReads = 0;
        var safeLeaks = 0;
        var safeTorn = 0;
        var safeReads = 0;
        var safeRejections = 0;
        string? firstSafeLeakSample = null;

        bool IsLeak(string content) =>
            secret.Length > 0 && content.Contains(secret, StringComparison.Ordinal);
        bool IsHonest(string content) => content.Contains("honest", StringComparison.Ordinal);
        var stopwatch = Stopwatch.StartNew();

        for (var i = 0; i < rounds; i++)
        {
            // --- The obvious order: decide, then open. ---
            var expected = PathContainment.Validate(ScratchRoot, TargetName, out _);
            if (expected is not null)
            {
                try
                {
                    var naive = File.ReadAllText(expected);
                    naiveReads++;
                    if (IsLeak(naive))
                    {
                        naiveLeaks++;
                    }
                    else if (!IsHonest(naive))
                    {
                        naiveTorn++;
                    }
                }
                catch (IOException)
                {
                }
                catch (UnauthorizedAccessException)
                {
                }
            }

            // --- The correct order: open, then decide about the descriptor. ---
            var safe = PathContainment.ReadContained(ScratchRoot, TargetName, 256 * 1024, out var reason);
            if (safe is not null)
            {
                safeReads++;
                if (IsLeak(safe))
                {
                    safeLeaks++;
                    firstSafeLeakSample ??= safe.Length > 60 ? safe[..60] : safe;
                }
                else if (!IsHonest(safe))
                {
                    safeTorn++;
                }
            }
            else if (reason.StartsWith("rejected", StringComparison.Ordinal))
            {
                safeRejections++;
            }
        }

        swapping.Cancel();
        try
        {
            swapper.Wait(TimeSpan.FromSeconds(5));
        }
        catch (AggregateException)
        {
        }

        result["elapsedMs"] = stopwatch.ElapsedMilliseconds;
        result["swapsPerformed"] = Interlocked.Read(ref swaps);
        result["secretFingerprintFound"] = secret.Length > 0;
        result["validateThenOpen_reads"] = naiveReads;
        result["validateThenOpen_leaks"] = naiveLeaks;
        result["validateThenOpen_tornReads"] = naiveTorn;
        result["openThenValidate_reads"] = safeReads;
        result["openThenValidate_leaks"] = safeLeaks;
        result["openThenValidate_tornReads"] = safeTorn;
        result["openThenValidate_rejections"] = safeRejections;
        result["openThenValidate_firstLeakSample"] = firstSafeLeakSample;
        result["verdict"] = safeLeaks == 0
            ? (naiveLeaks > 0
                ? "validate-then-open leaked " + naiveLeaks.ToString(CultureInfo.InvariantCulture)
                  + " of " + naiveReads.ToString(CultureInfo.InvariantCulture)
                  + " reads; open-then-validate leaked 0 of "
                  + safeReads.ToString(CultureInfo.InvariantCulture)
                : "no leak observed either way this run — increase iterations")
            : "OPEN-THEN-VALIDATE LEAKED — the fix is wrong";

        ResetToHonestFile(target);
        return result;
    }

    private static void ResetToHonestFile(string target)
    {
        try
        {
            File.Delete(target);
        }
        catch (IOException)
        {
        }

        File.WriteAllText(target, HonestContents);
    }
}
