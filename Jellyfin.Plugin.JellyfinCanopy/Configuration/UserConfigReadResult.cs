namespace Jellyfin.Plugin.JellyfinCanopy.Configuration
{
    /// <summary>
    /// Outcome of a per-user configuration read, distinguishing an intentionally
    /// absent/empty policy from a persistence fault. Security enforcement callers
    /// (Hidden Content, Spoiler Guard) MUST branch on this instead of the lenient
    /// <see cref="UserConfigurationStore.GetUserConfiguration{T}"/> path, which
    /// collapses every fault into <c>new T()</c> and would silently disable
    /// protection.
    /// </summary>
    public enum UserConfigReadStatus
    {
        /// <summary>File does not exist. Legitimately an empty policy.</summary>
        Missing,

        /// <summary>File existed and deserialized to a usable value.</summary>
        Valid,

        /// <summary>
        /// File existed but its content is unusable: empty, literal <c>null</c>,
        /// malformed JSON, or a payload that deserialized to null. The previous
        /// policy must NOT be treated as empty.
        /// </summary>
        Corrupt,

        /// <summary>
        /// File could not be read (I/O error, permission failure, or any other
        /// escaping exception). Transient; the previous policy must NOT be treated
        /// as empty.
        /// </summary>
        Unavailable,
    }

    /// <summary>
    /// Result of <see cref="UserConfigurationStore.ReadUserConfiguration{T}"/>.
    /// <see cref="Value"/> is populated only for <see cref="UserConfigReadStatus.Missing"/>
    /// (a fresh <c>new T()</c>) and <see cref="UserConfigReadStatus.Valid"/>; it is
    /// <c>null</c> for the two fault statuses so a caller cannot accidentally treat a
    /// fault as an empty policy.
    /// </summary>
    /// <typeparam name="T">The per-user configuration type.</typeparam>
    public readonly struct UserConfigReadResult<T>
        where T : new()
    {
        public UserConfigReadResult(
            UserConfigReadStatus status,
            T? value,
            string? faultDetail,
            bool wasCreated = false)
        {
            Status = status;
            Value = value;
            FaultDetail = faultDetail;
            WasCreated = wasCreated;
        }

        /// <summary>Gets the classified read outcome.</summary>
        public UserConfigReadStatus Status { get; }

        /// <summary>Gets the parsed value (Missing → new T(); Valid → parsed; faults → null).</summary>
        public T? Value { get; }

        /// <summary>Gets a short machine/operator-facing reason for a fault, or null when not a fault.</summary>
        public string? FaultDetail { get; }

        /// <summary>
        /// Gets a value indicating whether this operation atomically materialized
        /// the returned value after observing a genuinely missing file.
        /// </summary>
        public bool WasCreated { get; }

        /// <summary>Gets a value indicating whether this read is a persistence fault (Corrupt or Unavailable).</summary>
        public bool IsFault => Status is UserConfigReadStatus.Corrupt or UserConfigReadStatus.Unavailable;

        /// <summary>Gets a value indicating whether this read yielded a usable value (Missing or Valid).</summary>
        public bool HasUsableValue => Status is UserConfigReadStatus.Missing or UserConfigReadStatus.Valid;
    }
}
