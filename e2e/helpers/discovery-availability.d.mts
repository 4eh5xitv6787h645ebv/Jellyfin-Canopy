export type DiscoveryLibraryAvailability =
    | Readonly<{ available: true; reason: null }>
    | Readonly<{ available: false; reason: string }>;

export function discoveryLibraryAvailability(
    config: Readonly<Record<string, unknown>> | null | undefined,
): DiscoveryLibraryAvailability;
