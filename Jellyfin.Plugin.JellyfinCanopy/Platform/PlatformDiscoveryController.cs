using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>
    /// Entry point for Platform v1: what the platform is, and what it will speak to
    /// this particular caller.
    /// </summary>
    [Route(PlatformConstants.RoutePrefix)]
    public class PlatformDiscoveryController : PlatformControllerBase
    {
        /// <summary>
        /// Anonymous availability probe.
        ///
        /// This is the ONLY anonymous route in Platform v1, and its payload is
        /// deliberately uninteresting: whether the platform is present, and which
        /// protocol versions it speaks. Nothing else — no users, no installed
        /// extensions, no topology, no configuration, no server identity.
        ///
        /// It is anonymous because a client has to be able to discover whether the
        /// platform exists at all before it has a reason to authenticate, and because
        /// probing it tells an unauthenticated caller nothing they could not learn by
        /// noticing the plugin is installed.
        /// </summary>
        [HttpGet("discovery")]
        [AllowAnonymous]
        [PlatformCacheable]
        public ActionResult<PlatformDiscoveryResponse> GetDiscovery() => Ok(new PlatformDiscoveryResponse
        {
            Available = true,
            ProtocolMinimum = PlatformConstants.ProtocolMinimum,
            ProtocolMaximum = PlatformConstants.ProtocolMaximum,
        });

        /// <summary>
        /// Authenticated negotiation: the highest protocol version both sides speak.
        ///
        /// A client offers the range it supports; the host answers with what it will
        /// actually use. No overlap is its own outcome, distinct from "unavailable"
        /// and from "denied", because a client renders those three differently.
        /// </summary>
        [HttpGet("negotiate")]
        [PlatformCacheable]
        public ActionResult<PlatformNegotiationResponse> Negotiate(
            [FromQuery] int? protocolMinimum,
            [FromQuery] int? protocolMaximum)
        {
            var clientMinimum = protocolMinimum ?? PlatformConstants.ProtocolMinimum;
            var clientMaximum = protocolMaximum ?? PlatformConstants.ProtocolMinimum;

            var negotiated = clientMaximum < PlatformConstants.ProtocolMaximum
                ? clientMaximum
                : PlatformConstants.ProtocolMaximum;
            var floor = clientMinimum > PlatformConstants.ProtocolMinimum
                ? clientMinimum
                : PlatformConstants.ProtocolMinimum;

            if (negotiated < floor)
            {
                return Ok(new PlatformNegotiationResponse
                {
                    Compatible = false,
                    HostProtocolMinimum = PlatformConstants.ProtocolMinimum,
                    HostProtocolMaximum = PlatformConstants.ProtocolMaximum,
                });
            }

            return Ok(new PlatformNegotiationResponse
            {
                Compatible = true,
                Protocol = negotiated,
                HostProtocolMinimum = PlatformConstants.ProtocolMinimum,
                HostProtocolMaximum = PlatformConstants.ProtocolMaximum,
            });
        }
    }

    /// <summary>Anonymous discovery payload. Adding a field here widens what an unauthenticated caller learns.</summary>
    public class PlatformDiscoveryResponse
    {
        /// <summary>Whether the platform is present and serving.</summary>
        public bool Available { get; set; }

        /// <summary>Lowest protocol version this host speaks.</summary>
        public int ProtocolMinimum { get; set; }

        /// <summary>Highest protocol version this host speaks.</summary>
        public int ProtocolMaximum { get; set; }
    }

    /// <summary>Result of negotiating a protocol version with an authenticated caller.</summary>
    public class PlatformNegotiationResponse
    {
        /// <summary>Whether the client and host ranges overlap at all.</summary>
        public bool Compatible { get; set; }

        /// <summary>The agreed version. Meaningless when <see cref="Compatible"/> is false.</summary>
        public int? Protocol { get; set; }

        /// <summary>Echoed so a client can report the mismatch usefully rather than just failing.</summary>
        public int HostProtocolMinimum { get; set; }

        /// <summary>Echoed so a client can report the mismatch usefully rather than just failing.</summary>
        public int HostProtocolMaximum { get; set; }
    }
}
