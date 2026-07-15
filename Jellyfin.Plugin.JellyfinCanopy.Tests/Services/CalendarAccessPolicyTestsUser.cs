using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

internal static class CalendarAccessPolicyTestsUser
{
    internal static User Enabled(params Guid[] folderIds)
    {
        var user = new User("calendar-resolver-user", "provider", "password-provider");
        user.AddDefaultPermissions();
        user.AddDefaultPreferences();
        user.SetPermission(PermissionKind.EnableAllFolders, false);
        user.SetPreference(PreferenceKind.EnabledFolders, folderIds);
        return user;
    }
}
