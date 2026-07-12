using MediaBrowser.Common.Configuration;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;

/// <summary>Minimal IApplicationPaths rooted at a single directory (e.g. for the file-log provider).</summary>
public sealed class StubAppPaths : IApplicationPaths
{
    private readonly string _baseDir;

    public StubAppPaths(string baseDir) => _baseDir = baseDir;

    public string ProgramDataPath => _baseDir;
    public string WebPath => _baseDir;
    public string ProgramSystemPath => _baseDir;
    public string DataPath => _baseDir;
    public string ImageCachePath => _baseDir;
    public string PluginsPath => _baseDir;
    public string PluginConfigurationsPath => _baseDir;
    public string LogDirectoryPath => _baseDir;
    public string ConfigurationDirectoryPath => _baseDir;
    public string SystemConfigurationFilePath => Path.Combine(_baseDir, "system.xml");
    public string CachePath => _baseDir;
    public string TempDirectory => _baseDir;
    public string VirtualDataPath => _baseDir;
    public string TrickplayPath => _baseDir;
    public string BackupPath => _baseDir;

    public void MakeSanityCheckOrThrow()
    {
    }

    public void CreateAndCheckMarker(string path, string markerName, bool recursive = false)
    {
    }
}
