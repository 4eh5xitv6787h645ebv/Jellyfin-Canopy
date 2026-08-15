using Jellyfin.Plugin.JellyfinCanopy.ScheduledTasks;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.ScheduledTasks;

public sealed class RefreshAwardsIndexTaskTests
{
    [Fact]
    public void StableSchedule_IsDeterministicAndDistributedWithinWeek()
    {
        var first = RefreshAwardsIndexTask.StableSchedule("server-a");
        var repeated = RefreshAwardsIndexTask.StableSchedule("server-a");
        var second = RefreshAwardsIndexTask.StableSchedule("server-b");

        Assert.Equal(first, repeated);
        Assert.NotEqual(first, second);
        Assert.InRange((int)first.Day, 0, 6);
        Assert.InRange(first.Time, TimeSpan.Zero, TimeSpan.FromDays(1) - TimeSpan.FromTicks(1));
    }
}
