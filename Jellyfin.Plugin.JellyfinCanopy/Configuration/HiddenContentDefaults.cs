namespace Jellyfin.Plugin.JellyfinCanopy.Configuration
{
    /// <summary>Builds the one persisted Hidden Content default-settings shape.</summary>
    internal static class HiddenContentDefaults
    {
        internal static HiddenContentSettings Create(PluginConfiguration source)
        {
            ArgumentNullException.ThrowIfNull(source);
            return new HiddenContentSettings
            {
                Enabled = source.HiddenContentDefaultEnabled,
                ShowHideButtons = source.HiddenContentDefaultShowHideButtons,
                ShowHideConfirmation = source.HiddenContentDefaultShowHideConfirmation,
                ShowButtonSeerr = source.HiddenContentDefaultShowButtonSeerr,
                ShowButtonLibrary = source.HiddenContentDefaultShowButtonLibrary,
                ShowButtonDetails = source.HiddenContentDefaultShowButtonDetails,
                ShowButtonCast = source.HiddenContentDefaultShowButtonCast,
                FilterLibrary = source.HiddenContentDefaultFilterLibrary,
                FilterDiscovery = source.HiddenContentDefaultFilterDiscovery,
                FilterSearch = source.HiddenContentDefaultFilterSearch,
                FilterCalendar = source.HiddenContentDefaultFilterCalendar,
                FilterUpcoming = source.HiddenContentDefaultFilterUpcoming,
                FilterRecommendations = source.HiddenContentDefaultFilterRecommendations,
                FilterRequests = source.HiddenContentDefaultFilterRequests,
                FilterNextUp = source.HiddenContentDefaultFilterNextUp,
                FilterContinueWatching = source.HiddenContentDefaultFilterContinueWatching,
                ExperimentalHideCollections = source.HiddenContentDefaultExperimentalHideCollections,
            };
        }
    }
}
