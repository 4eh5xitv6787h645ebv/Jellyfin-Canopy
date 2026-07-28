using System.Globalization;
using Microsoft.Win32.SafeHandles;

namespace Jellyfin.Plugin.Ep00Host;

/// <summary>
/// EP-00.5. The containment decision, extracted from <see cref="ManifestProbe"/> so
/// it can be exercised without a running server — and so EP-03 inherits one
/// implementation instead of re-deriving it.
///
/// The ordering here is the whole point. Validating a path and *then* opening it
/// leaves a window in which the path can be swapped; every check is therefore
/// re-applied to the handle that will actually be read.
/// </summary>
public static class PathContainment
{
    /// <summary>Why a candidate was refused. Stable strings — they appear in evidence.</summary>
    public const string ReasonAccepted = "accepted";

    /// <summary>Upper bound on link-resolution passes, so a pathological chain cannot spin.</summary>
    public const int MaximumLinkResolutionPasses = 40;

    /// <summary>How long open(2) may take before the candidate is refused.</summary>
    private static readonly TimeSpan OpenTimeout = TimeSpan.FromSeconds(2);

    /// <summary>
    /// Decides whether <paramref name="relativeName"/> may be read from
    /// <paramref name="root"/>, without touching the file's contents.
    /// </summary>
    /// <returns>The resolved absolute path when accepted, otherwise null.</returns>
    public static string? Validate(string? root, string relativeName, out string reason)
    {
        if (string.IsNullOrWhiteSpace(root))
        {
            reason = "rejected: no root path";
            return null;
        }

        if (relativeName.Length == 0)
        {
            reason = "rejected: empty name";
            return null;
        }

        if (relativeName.Contains('\0', StringComparison.Ordinal))
        {
            reason = "rejected: embedded NUL in name";
            return null;
        }

        // Normalise BOTH separators before any test. A backslash is a legal filename
        // character on Unix, so without this a Windows-style traversal is treated as
        // an ordinary filename and appears to be "rejected" when it was never
        // evaluated at all.
        var normalised = relativeName
            .Replace('\\', Path.DirectorySeparatorChar)
            .Replace('/', Path.DirectorySeparatorChar);

        if (Path.IsPathRooted(normalised))
        {
            reason = "rejected: absolute path";
            return null;
        }

        string canonicalRoot;
        string candidate;
        try
        {
            canonicalRoot = Path.TrimEndingDirectorySeparator(ResolveToFixedPoint(Path.GetFullPath(root)));
            candidate = Path.GetFullPath(Path.Combine(canonicalRoot, normalised));
        }
        catch (Exception ex)
        {
            reason = "rejected: unresolvable path (" + ex.GetType().Name + ")";
            return null;
        }

        if (!IsInside(candidate, canonicalRoot))
        {
            reason = "rejected: resolves outside plugin root";
            return null;
        }

        string resolved;
        try
        {
            resolved = ResolveToFixedPoint(candidate);
        }
        catch (Exception ex)
        {
            reason = "rejected: unresolvable link target (" + ex.GetType().Name + ")";
            return null;
        }

        if (!IsInside(resolved, canonicalRoot))
        {
            reason = "rejected: symlink escapes plugin root";
            return null;
        }

        reason = ReasonAccepted;
        return resolved;
    }

    /// <summary>
    /// Opens <paramref name="relativeName"/> under <paramref name="root"/> and returns
    /// its contents, or null with a reason.
    ///
    /// Correctness rests on the order: the file is opened first, and containment is
    /// then decided against the path the **open descriptor** actually refers to. The
    /// obvious order — validate, then open — can be defeated by swapping the path in
    /// between, which <see cref="Ep00SpikeController"/>'s race probe demonstrates.
    /// </summary>
    public static string? ReadContained(string? root, string relativeName, long maximumBytes, out string reason)
    {
        var expected = Validate(root, relativeName, out reason);
        if (expected is null)
        {
            return null;
        }

        var canonicalRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root!));
        try
        {
            canonicalRoot = Path.TrimEndingDirectorySeparator(ResolveToFixedPoint(canonicalRoot));
        }
        catch (IOException)
        {
            reason = "rejected: unresolvable root";
            return null;
        }

        if (Directory.Exists(expected))
        {
            reason = "rejected: not a regular file (directory)";
            return null;
        }

        FileStream stream;
        try
        {
            // O_NOFOLLOW is not exposed by FileStream, so the leaf is re-checked below
            // against the descriptor rather than assumed.
            //
            // The open is bounded because open(2) BLOCKS on a FIFO until a writer
            // appears. A plugin that ships a named pipe called
            // jellyfin-canopy-extension.json would otherwise hang the reader — and
            // discovery iterates every plugin, so one such file stalls all of them.
            stream = OpenBounded(expected, OpenTimeout);
        }
        catch (TimeoutException)
        {
            reason = "rejected: open blocked (not a regular file?)";
            return null;
        }
        catch (FileNotFoundException)
        {
            reason = "absent: no file at " + Path.GetRelativePath(canonicalRoot, expected);
            return null;
        }
        catch (DirectoryNotFoundException)
        {
            reason = "absent: no file at " + Path.GetRelativePath(canonicalRoot, expected);
            return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            reason = "rejected: unopenable (" + ex.GetType().Name + ")";
            return null;
        }

        using (stream)
        {
            // Everything from here on describes the OPEN DESCRIPTOR, not a path that
            // may since have changed underneath us.
            var actual = DescribeOpenHandle(stream.SafeFileHandle);
            if (actual is null)
            {
                // FAIL CLOSED. Falling back to the pre-open decision here is precisely
                // the hole this method exists to close: when the path is being swapped,
                // the descriptor often cannot be described (a deleted inode resolves to
                // "<path> (deleted)"), which is exactly when the pre-open decision is
                // least trustworthy. Measured: keeping the fallback leaked on ~17% of
                // successful reads under contention.
                reason = "rejected: cannot verify the opened descriptor";
                return null;
            }

            if (!IsInside(actual, canonicalRoot))
            {
                reason = "rejected: opened file resolves outside plugin root";
                return null;
            }

            if (!string.Equals(actual, expected, StringComparison.Ordinal))
            {
                // Inside the root, but not the file we validated — the path changed
                // between the decision and the open.
                reason = "rejected: path changed between validation and open";
                return null;
            }

            long length;
            try
            {
                length = stream.Length;
            }
            catch (IOException ex)
            {
                reason = "rejected: unreadable (" + ex.GetType().Name + ")";
                return null;
            }

            if (length > maximumBytes)
            {
                reason = "rejected: exceeds " + (maximumBytes / 1024).ToString(CultureInfo.InvariantCulture) + " KiB";
                return null;
            }

            try
            {
                using var reader = new StreamReader(stream);
                var contents = reader.ReadToEnd();
                reason = ReasonAccepted;
                return contents;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                reason = "rejected: unreadable (" + ex.GetType().Name + ")";
                return null;
            }
        }
    }

    /// <summary>
    /// Opens a file, refusing to wait indefinitely. open(2) on a FIFO blocks until a
    /// writer appears, and the caller cannot afford that.
    /// </summary>
    private static FileStream OpenBounded(string path, TimeSpan timeout)
    {
        var open = Task.Run(() => new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite));

        // Wait on the handle rather than Task.Wait: Task.Wait wraps a faulted task's
        // exception in an AggregateException, which would slip past the caller's
        // specific catches and escape as an unhandled error. Waiting on the handle
        // never throws, so GetAwaiter().GetResult() below rethrows the ORIGINAL
        // FileNotFoundException / UnauthorizedAccessException unchanged.
        if (!((IAsyncResult)open).AsyncWaitHandle.WaitOne(timeout))
        {
            // The task is abandoned deliberately: it is stuck in a blocking syscall and
            // cannot be cancelled. It completes if a writer ever appears, and the stream
            // is then dropped unreferenced.
            _ = open.ContinueWith(
                t => t.Result.Dispose(),
                CancellationToken.None,
                TaskContinuationOptions.OnlyOnRanToCompletion | TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
            throw new TimeoutException("open did not complete within " + timeout);
        }

        return open.GetAwaiter().GetResult();
    }

    /// <summary>
    /// The real path behind an open descriptor, via <c>/proc/self/fd</c>. Returns null
    /// when the descriptor cannot be described — the caller must then refuse the read,
    /// not fall back to the pre-open decision. Linux-only, which is why this spike is.
    /// </summary>
    private static string? DescribeOpenHandle(SafeFileHandle handle)
    {
        if (handle.IsInvalid)
        {
            return null;
        }

        var fdPath = "/proc/self/fd/" + handle.DangerousGetHandle().ToInt64().ToString(CultureInfo.InvariantCulture);
        try
        {
            // returnFinalTarget:false — /proc/self/fd/N is a link to the real path, and
            // that first hop is the answer. Following further would re-introduce a
            // resolution the descriptor has already settled.
            var target = File.ResolveLinkTarget(fdPath, returnFinalTarget: false);
            if (target is null)
            {
                return null;
            }

            var full = target.FullName;

            // A deleted inode resolves to "<path> (deleted)". That is not a path we can
            // contain, so treat it as undescribable and let the caller fail closed.
            return full.EndsWith(" (deleted)", StringComparison.Ordinal)
                ? null
                : Path.GetFullPath(full);
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>Resolves links repeatedly until the path stops changing.</summary>
    public static string ResolveToFixedPoint(string path)
    {
        var resolved = path;
        for (var i = 0; i < MaximumLinkResolutionPasses; i++)
        {
            var next = ResolveOnce(resolved);
            if (string.Equals(next, resolved, StringComparison.Ordinal))
            {
                return resolved;
            }

            resolved = next;
        }

        throw new IOException("Link resolution did not converge after "
            + MaximumLinkResolutionPasses.ToString(CultureInfo.InvariantCulture) + " passes.");
    }

    /// <summary>
    /// Resolves every symlink in <paramref name="path"/>, one component at a time.
    /// Unix-shaped: it splits on the platform separator and rebuilds from a bare
    /// separator, so it does not handle Windows drive or UNC roots. Adequate for a
    /// Linux-only throwaway spike; must not be lifted into the kernel as-is.
    /// </summary>
    private static string ResolveOnce(string path)
    {
        var parts = path.Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries);
        var current = Path.DirectorySeparatorChar.ToString();
        foreach (var part in parts)
        {
            current = Path.Combine(current, part);

            // A component that does not exist cannot be a link, and asking anyway
            // throws — which would turn a legitimately absent file into an
            // "unresolvable link" error.
            var isDirectory = Directory.Exists(current);
            if (!isDirectory && !File.Exists(current))
            {
                continue;
            }

            FileSystemInfo? target;
            try
            {
                target = isDirectory
                    ? new DirectoryInfo(current).ResolveLinkTarget(true)
                    : new FileInfo(current).ResolveLinkTarget(true);
            }
            catch (IOException)
            {
                // Cyclic or otherwise unresolvable. Leaving it unresolved would let
                // containment pass on a path we cannot reason about: fail closed.
                throw;
            }

            if (target is not null)
            {
                current = Path.GetFullPath(target.FullName);
            }
        }

        return current;
    }

    /// <summary>True when <paramref name="candidate"/> is at or below <paramref name="canonicalRoot"/>.</summary>
    public static bool IsInside(string candidate, string canonicalRoot)
    {
        if (string.Equals(candidate, canonicalRoot, StringComparison.Ordinal))
        {
            return true;
        }

        // A root that is already a single separator would otherwise demand a doubled
        // separator and reject everything.
        var prefix = canonicalRoot.EndsWith(Path.DirectorySeparatorChar)
            ? canonicalRoot
            : canonicalRoot + Path.DirectorySeparatorChar;

        return candidate.StartsWith(prefix, StringComparison.Ordinal);
    }
}
