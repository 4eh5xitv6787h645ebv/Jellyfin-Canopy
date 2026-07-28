namespace Ep00.Contracts;

/// <summary>
/// A deliberately "shared" contract interface. Both spike plugins ship their own
/// copy of SpikeContracts.dll. If Jellyfin 12 gave plugins common type identity,
/// the host plugin could cast the provider's registered object to this type.
/// The spike exists to prove it cannot.
/// </summary>
public interface IExtensionProvider
{
    string ProviderId { get; }

    string Invoke(string operationId, string requestJson);
}
