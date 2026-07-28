namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>
    /// The single Platform v1 error envelope.
    ///
    /// The legacy <c>/JellyfinCanopy/*</c> surface returns at least four different shapes
    /// — <c>{ error = "message" }</c>, <c>{ error = true, code, message }</c>,
    /// <c>{ ok = false, message }</c>, and bare string bodies — so a consumer cannot tell
    /// one failure from another without knowing which endpoint it called. Platform v1
    /// returns this and only this.
    ///
    /// The shape is a deliberate SUPERSET of the richest legacy shape
    /// (<c>{ error, code, message }</c>), so an adapter that has to present a platform
    /// failure to a legacy consumer drops fields rather than translating them
    /// (ADR-0002). Legacy endpoints are not retrofitted; they keep what they have.
    ///
    /// What is NOT here is as deliberate as what is: no stack traces, no exception types,
    /// no inner messages, no paths, no configuration. An unhandled exception becomes
    /// <see cref="PlatformErrorCode.InternalError"/> with a fixed message, and the detail
    /// goes to the log under the same correlation id.
    /// </summary>
    public class PlatformError
    {
        /// <summary>
        /// Always <c>true</c>.
        ///
        /// Carried because the legacy shape carries it, so a consumer that already
        /// branches on a truthy <c>error</c> keeps working through an adapter. It conveys
        /// nothing on its own — this type is only ever serialized on a failure path.
        /// </summary>
        public bool Error { get; set; } = true;

        /// <summary>
        /// The machine-readable code from <see cref="PlatformErrorCode"/>. Branch on this.
        /// </summary>
        public string Code { get; set; } = PlatformErrorCode.InternalError;

        /// <summary>
        /// Human-readable and safe to display. May be reworded or translated at any time,
        /// so it is never the thing a consumer branches on.
        /// </summary>
        public string Message { get; set; } = string.Empty;

        /// <summary>
        /// Whether retrying the same request could plausibly succeed. Derived from
        /// <see cref="Code"/> rather than chosen per call site, so two endpoints cannot
        /// disagree about the same code.
        /// </summary>
        public bool Retryable { get; set; }

        /// <summary>
        /// Ties this response to the server-side log lines for the same request.
        ///
        /// This is the field that makes a user-reported symptom traceable: it is returned
        /// in the body, echoed in the <c>X-Correlation-Id</c> response header, and present
        /// on every log line the request produces.
        /// </summary>
        public string CorrelationId { get; set; } = string.Empty;
    }
}
