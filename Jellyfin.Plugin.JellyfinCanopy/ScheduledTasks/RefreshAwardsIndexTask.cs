using System.Security.Cryptography;
using System.Text;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Awards;
using MediaBrowser.Model.Tasks;

namespace Jellyfin.Plugin.JellyfinCanopy.ScheduledTasks
{
    /// <summary>Manual/weekly refresh of the optional local Wikidata awards index.</summary>
    public sealed class RefreshAwardsIndexTask : IScheduledTask
    {
        private readonly AwardsIndexService _indexService;
        private readonly IPluginConfigProvider _configProvider;
        private readonly AwardsHostIdentity _hostIdentity;

        public RefreshAwardsIndexTask(
            AwardsIndexService indexService,
            IPluginConfigProvider configProvider,
            AwardsHostIdentity hostIdentity)
        {
            _indexService = indexService;
            _configProvider = configProvider;
            _hostIdentity = hostIdentity;
        }

        public string Name => "Refresh Awards Index";

        public string Key => "JellyfinCanopyRefreshAwardsIndex";

        public string Description => "Refreshes the optional, local Wikidata awards and nominations index. Disabled unless Awards is enabled in Canopy settings.";

        public string Category => "Jellyfin Canopy";

        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
        {
            var (day, time) = StableSchedule(_hostIdentity.SystemId);
            return new[]
            {
                new TaskTriggerInfo
                {
                    Type = TaskTriggerInfoType.WeeklyTrigger,
                    DayOfWeek = day,
                    TimeOfDayTicks = time.Ticks,
                    MaxRuntimeTicks = TimeSpan.FromMinutes(20).Ticks,
                },
            };
        }

        public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            progress.Report(0);
            if (_configProvider.ConfigurationOrNull?.AwardsEnabled != true)
            {
                progress.Report(100);
                return;
            }

            if (!await _indexService.RefreshAsync(cancellationToken).ConfigureAwait(false))
            {
                throw new InvalidOperationException(
                    "The Wikidata awards refresh failed or remains incomplete; the last complete index was retained. "
                    + "If bounded continuation progress was saved, wait for this task to finish and run it again.");
            }

            progress.Report(100);
        }

        internal static (DayOfWeek Day, TimeSpan Time) StableSchedule(string systemId)
        {
            // PERF(S5): spread an opt-in 100k-install fleet across all 604,800
            // week-seconds. Startup/upgrade performs no provider I/O.
            var hash = SHA256.HashData(Encoding.UTF8.GetBytes(systemId ?? string.Empty));
            var secondOfWeek = BitConverter.ToUInt32(hash, 0) % (7U * 24U * 60U * 60U);
            return (
                (DayOfWeek)(secondOfWeek / (24U * 60U * 60U)),
                TimeSpan.FromSeconds(secondOfWeek % (24U * 60U * 60U)));
        }
    }
}
