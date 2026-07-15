using System.Runtime.CompilerServices;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Configuration;

internal static class SqliteTestProvider
{
    [ModuleInitializer]
    internal static void Initialize()
    {
        SQLitePCL.raw.SetProvider(new SQLitePCL.SQLite3Provider_sqlite3());
    }
}
