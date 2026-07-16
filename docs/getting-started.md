# Getting Started

Jellyfin Canopy layers a richer, faster front-end and a set of opt-in power features on top of your Jellyfin server. This guide takes you from a fresh Jellyfin 12 install to a working Enhanced Panel, then points you at the one-time setup that turns on the features you care about. Budget about ten minutes.

!!! info "Prerequisites"

    - Jellyfin server version **12.x**
    - **Admin access** to your Jellyfin server
    - A modern web browser (Chrome, Firefox, Edge, or Safari)

## Jellyfin 12 only

Jellyfin Canopy targets **Jellyfin 12 and nothing else**. Its manifest publishes only a Jellyfin 12 build (target ABI `12.0.0.0`), so a Jellyfin 10.11 server's catalog will never list it — there is no 10.11-compatible release to install.

If you're still on Jellyfin 10.11, install the original [Jellyfin Enhanced](https://github.com/n00bcodr/Jellyfin-Enhanced) plugin instead. When you later move to Jellyfin 12, Canopy can import that installation as described in [Upgrading from Jellyfin Enhanced](#upgrading-from-jellyfin-enhanced-1011).

## Install the plugin

Installation is the standard Jellyfin plugin flow: add the repository, install from the catalog, restart, and confirm the panel loads.

### Step 1 — Add the plugin repository

1. In Jellyfin, go to **Dashboard** → **Plugins** → **Catalog**.
2. Click the gear icon (⚙️ **Manage Repositories**), then click **➕** (Add) to add a new repository.
3. Give the repository a name, for example "Jellyfin Canopy".
4. Set the **Repository URL** to the manifest:

    ```
    https://raw.githubusercontent.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/main/manifest.json
    ```

5. Click **Save**.

### Step 2 — Install from the catalog

1. Open the **Catalog** tab.
2. Find **Jellyfin Canopy** in the plugin list.
3. Click **Install**.
4. Wait for the installation to complete.

### Step 3 — Restart your server

Restart your Jellyfin server to finish the install — the plugin doesn't take effect until you do.

### Step 4 — Verify the panel appears

After the restart:

1. Refresh your browser with a hard reload (++ctrl+f5++ or ++command+shift+r++).
2. Open the Jellyfin Canopy settings panel — either route works:
    - In the sidebar, under the **Jellyfin Canopy** heading, click **Enhanced Panel**.
    - Or press `?`.
3. If the **Enhanced Panel** opens, the install worked.

If nothing appears, jump to [Troubleshooting the install](#troubleshooting-the-install).

## Upgrading from Jellyfin Enhanced (10.11)

Jellyfin Enhanced and Jellyfin Canopy are separate plugins with different IDs and storage roots, so Jellyfin's catalog cannot update one into the other. Canopy has a one-time importer for the final Enhanced 10.11 state.

1. Before upgrading, stop Jellyfin and back up its complete configuration directory. Keep that backup until you have verified the migration.
2. Upgrade Jellyfin to 12, add the Canopy repository, install Canopy, and restart Jellyfin.
3. On its first startup, Canopy looks for Enhanced's administration XML and `configurations/Jellyfin.Plugin.JellyfinEnhanced` directory. It validates and stages a copy before publishing it under the Canopy names.
4. Check the Jellyfin log for both `Imported Jellyfin Enhanced` messages, then verify the admin page and each user's settings, shortcuts, bookmarks, hidden content, Elsewhere preferences, reviews, and custom branding.

The importer never modifies or removes Enhanced's files. They remain the rollback/export copy. Running Canopy again is idempotent: a completed import is not replayed over newer Canopy changes, while an interrupted staged copy is rebuilt on the next restart.

!!! warning "Conflicts are never auto-merged"

    If Canopy already has an independently created configuration or non-empty data directory, the importer imports **nothing** and logs both paths. This prevents a mixed installation and makes the existing Canopy state the winner. The decision is recorded in `Jellyfin.Plugin.JellyfinCanopy.xml.enhanced-import.json`, so later restarts do not repeatedly attempt the import. To retry the automatic Enhanced import, stop Jellyfin, back up and move aside the Canopy XML, that marker, and the `configurations/Jellyfin.Plugin.JellyfinCanopy` directory, then restart. If you need values from both installations, retain both backups and reconcile them manually; do not copy individual live files while Jellyfin is running.

Malformed Enhanced administration XML, or malformed critical Enhanced JSON such as settings, bookmarks, hidden content, or reviews, also blocks publication. Canopy logs the exact source file and refuses to finish loading for that startup, preventing defaults or background writers from contaminating the retry path; Jellyfin itself remains available. Repair or move aside the reported source, then restart. A genuinely missing XML or data half is reported by its absence and the available half is still imported.

The same fail-closed rule applies when the older Canopy `reviews.json` is first
converted to the indexed review database. An oversized file or one invalid review
key is preserved as `reviews.json.corrupt-*`, the original stays untouched, and
review endpoints return unavailable. Stop Jellyfin, repair the reported JSON entry
(or preserve and move the file aside if an empty review store is intentional), then
restart; a repaired file is retried automatically.

For rollback, stop Jellyfin, remove or move aside the Canopy installation/state, restore your pre-upgrade server backup, and start Jellyfin 10.11 with Enhanced. Because the importer copied rather than moved the Enhanced source, the original state is still available. Enhanced and Canopy are not intended to run side by side: Enhanced targets Jellyfin 10.11, while Canopy targets Jellyfin 12.

## Upgrading from Jellyfin Elevate

Versions before 2.0 were published as **Jellyfin Elevate**. It is the same plugin (same plugin ID), so the catalog offers the rebranded version as a normal update:

1. Update the plugin from the catalog and restart the server.
2. Your configuration, per-user settings, custom branding, and caches migrate automatically on first startup.
3. The only thing that does not carry over is custom **scheduled-task triggers** (Dashboard → Scheduled Tasks): the rebrand renames the task keys, so any schedule you changed by hand reverts to the plugin default — set it again once.

## First-run setup

You now have Jellyfin Canopy running, but most features are **off by default**, and several of the biggest ones need a one-time connection before they do anything. Everything below lives under **Dashboard** → **Plugins** → **Jellyfin Canopy**, on the tab named in each item. Turn on what you want and skip the rest.

!!! tip "The two states to watch for"

    A feature can be *on by default but inert* (it's enabled, but waiting on a key or connection you haven't provided yet), or *off until you enable it*. The checklist calls out which is which, so you know whether you're flipping a switch or filling in a credential.

### Add a TMDB API key

A TMDB API key is the single highest-value thing to set up first. One key unlocks a cluster of features:

- **Elsewhere** — where-to-watch availability
- **TMDB Reviews**
- **Release Dates**
- **People-tag enrichment**

Enter the key on the **Elsewhere** tab. **Elsewhere itself is on by default**, but it stays inert until a valid TMDB key is set — so without the key, none of the features above appear. See [Discover & Request](discover.md).

### Connect Seerr

A [Seerr](discover.md) connection powers two things at once: **media requests** and the **Discovery** feed.

- **Seerr integration is off** until you enable it and enter your Seerr URL and API key on the **Seerr** tab.
- **Discovery's own toggle is on by default**, but the feed shows nothing until a Seerr connection is configured.

So connecting Seerr is what brings both requests and Discovery to life. See [Discover & Request](discover.md).

### Add Sonarr / Radarr instances

To drive Sonarr and Radarr from inside Jellyfin — searching, adding, and managing — add one or more instances on the **\*arr** tab. The *arr features do nothing until at least one instance is configured. See [Sonarr & Radarr](sonarr-radarr.md).

### Enable Spoiler Guard

[Spoiler Guard](spoiler-guard.md) hides episode thumbnails, titles, and descriptions that could spoil what you haven't watched yet. It's **off until you enable it** on the **Pages** tab. The full walkthrough is in [Spoiler Guard](spoiler-guard.md).

### Everything else

Keyboard shortcuts, media tags, the pause screen, bookmarks, and the rest of the day-to-day polish live in the Enhanced experience and the customization options. Once the essentials above are in place, explore them at your own pace in [Customization](customization.md) and the other guides.

!!! note "Where every setting lives"

    Each admin option sits on one of the tabs in the plugin config page. For the full tab-by-tab map — which tab configures what, and where each area is documented — see [Reference](reference.md).

## Troubleshooting the install

Most install problems come down to a missed restart, a stale browser cache, or a misunderstanding of how the script is delivered. Work through the checks below in order.

### Plugin not appearing after installation

**Check installation status:**

1. Go to **Dashboard** → **Plugins**.
2. Verify **Jellyfin Canopy** is listed under **Installed**.
3. Check that it's enabled (not disabled).

**Clear your browser cache:**

1. Open the clear-cache dialog — Windows/Linux: ++ctrl+shift+delete++; macOS: ++command+shift+delete++.
2. Select "Cached images and files" (or similar).
3. Clear the cache.
4. Refresh your browser (++ctrl+f5++).

**Restart the server:**

1. In Jellyfin, go to **Dashboard** → **Restart**.
2. Wait for the server to fully restart.
3. Refresh your browser (++ctrl+f5++).

### Scripts not loading

!!! note "How the script is delivered on Jellyfin 12"

    By default the client script is injected at request time by the built-in injection middleware, which runs on every `/web/` index request independently of any scheduled task. Re-adding the `On application startup` trigger to the **Jellyfin Canopy Startup** task will **not** fix scripts failing to load in the default configuration — that task only performs background initialisation and cleanup and no longer governs script delivery.

**Check the browser console:**

1. Press ++f12++ to open developer tools.
2. Go to the **Console** tab.
3. Look for errors mentioning "Jellyfin Canopy".
4. Report any errors on GitHub.

**Legacy on-disk fallback:** the **Jellyfin Canopy Startup** task and its `On application startup` trigger only matter when an admin has switched to the legacy on-disk `index.html` rewrite (see [Permission issues](#permission-issues)). In that mode the task performs the on-disk rewrite at startup, so it should carry the `On application startup` trigger. If it's missing under **Dashboard** → **Scheduled Tasks**, add it manually.

### Update not working

If an update didn't take, do a clean reinstall:

1. Go to **Dashboard** → **Plugins** → **My Plugins**.
2. Find Jellyfin Canopy and click **Uninstall**.
3. Restart the server.
4. Reinstall from the **Catalog**.
5. Restart the server again.
6. Clear the browser cache (++ctrl+f5++).

### Permission issues

#### Default Jellyfin 12 permission contract

Jellyfin Canopy's default script and branding middleware work at request time. They do **not** need write access to Jellyfin's web or installation tree on Docker, Linux, or Windows. Leave `DisableScriptInjectionMiddleware` and `DisableBrandingMiddleware` at their default value, `false`; do not change ownership or permissions on Jellyfin binaries to install Canopy.

Uploaded branding is the relevant configuration write here. Canopy stores it in the `custom_branding` directory beside its plugin configuration, under Jellyfin's existing configuration owner. In the official container that is `/config/plugins/configurations/Jellyfin.Plugin.JellyfinCanopy/custom_branding`; native paths follow the Jellyfin configuration directory selected by that installation. Canopy never needs the branding directory to be moved into `jellyfin-web`.

If a log reports access denied for `jellyfin-web/index.html`, first open `Jellyfin.Plugin.JellyfinCanopy.xml` in Jellyfin's plugin-configurations directory and confirm `DisableScriptInjectionMiddleware` is `false`, then restart Jellyfin and force-refresh the browser. Canopy can also make one best-effort attempt to remove a stale on-disk Canopy tag left by an earlier legacy setup; an `Error during cleanup of old script` is non-fatal, and the narrow fix is to restore that exact package-owned `index.html`. For any other error with the flag at `false`, identify the component from the surrounding log lines instead of granting Canopy broader access.

#### Optional plugins that modify jellyfin-web

[File Transformation](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation), [Custom Tabs](https://github.com/IAmParadox27/jellyfin-plugin-custom-tabs), and [Plugin Pages](https://github.com/IAmParadox27/jellyfin-plugin-pages) are separate third-party components. Canopy does not use them on Jellyfin 12. If you choose a component that modifies `jellyfin-web`, use that component's Jellyfin-12 documentation for its exact target, service principal, permissions, backup, and rollback. A permission error from one of those components is not a reason to make the whole Jellyfin install writable.

#### Optional legacy on-disk fallback

Setting `DisableScriptInjectionMiddleware` to `true` is an advanced compatibility escape hatch. It makes the **Jellyfin Canopy Startup** task rewrite the `index.html` under Jellyfin's resolved web path. The crash-safe writer reads that file, creates and writes a temporary sibling, then atomically replaces the destination. The service principal therefore needs read access to `index.html` plus create, write, delete, and rename access in its immediate parent directory. It does not need access to the rest of the installation tree.

Do not wait for a success log to identify the path: the successful legacy-rewrite message does not include it. Discover the path and service principal from the running native service, and refuse to continue if discovery is ambiguous. The following procedures deliberately preserve the package owner and unrelated ACL entries.

##### Linux native service

Run this Bash block from an account with `sudo`. It reads the real systemd service user, then takes the web directory from the running process's `--webdir` argument or `JELLYFIN_WEB_DIR` environment. Only when neither is present does it accept one unambiguous `index.html` from the installed `jellyfin-web` package.

```bash
set -Eeuo pipefail

service_name=jellyfin
service_user="$(systemctl show "$service_name" --property=User --value)"
service_pid="$(systemctl show "$service_name" --property=MainPID --value)"
[ -n "$service_user" ] || service_user=root
case "$service_pid" in ''|0|*[!0-9]*) echo "Jellyfin must be running for safe path discovery" >&2; exit 1;; esac

web_dir="$(sudo awk '
    BEGIN { RS = "\0" }
    expect_web_dir { print; found = 1; exit }
    $0 == "--webdir" { expect_web_dir = 1; next }
    index($0, "--webdir=") == 1 { print substr($0, 10); found = 1; exit }
    END { if (expect_web_dir && !found) exit 2 }
' "/proc/$service_pid/cmdline")"

if [ -z "$web_dir" ]; then
    web_dir="$(sudo awk 'BEGIN { RS="\0" } /^JELLYFIN_WEB_DIR=/ { sub(/^JELLYFIN_WEB_DIR=/, ""); print; exit }' "/proc/$service_pid/environ")"
fi

if [ -n "$web_dir" ]; then
    index_path="${web_dir%/}/index.html"
else
    mapfile -t package_indexes < <(
        if command -v dpkg-query >/dev/null 2>&1; then dpkg-query -L jellyfin-web 2>/dev/null; fi
        if command -v rpm >/dev/null 2>&1; then rpm -ql jellyfin-web 2>/dev/null; fi
    )
    mapfile -t package_indexes < <(printf '%s\n' "${package_indexes[@]}" | awk '/\/index\.html$/ && !seen[$0]++')
    [ "${#package_indexes[@]}" -eq 1 ] || { echo "Could not identify exactly one package-owned index.html" >&2; exit 1; }
    index_path="${package_indexes[0]}"
fi

[ -f "$index_path" ] || { echo "Resolved index.html does not exist: $index_path" >&2; exit 1; }
index_dir="$(dirname -- "$index_path")"
backup_dir="$HOME/jellyfin-canopy-index-backup-$(date +%Y%m%dT%H%M%S)"
install -d -m 0700 -- "$backup_dir"
sudo cp --preserve=all -- "$index_path" "$backup_dir/index.html.original"
sudo getfacl --absolute-names -- "$index_path" "$index_dir" > "$backup_dir/access.acl"
sudo test -s "$backup_dir/index.html.original"
test -s "$backup_dir/access.acl"
sudo cmp --silent -- "$index_path" "$backup_dir/index.html.original"
sudo setfacl --test --restore="$backup_dir/access.acl" >/dev/null
sudo stat -c '%U:%G %a %n' -- "$index_path" "$index_dir"
printf 'Service principal: %s\nResolved index: %s\nRollback data: %s\n' "$service_user" "$index_path" "$backup_dir"
read -r -p 'Review those values, then type YES to add the narrow ACLs: ' confirmation
[ "$confirmation" = YES ] || { echo "No permissions changed" >&2; exit 1; }

restore_after_partial_grant() {
    local original_status="$1"
    local restore_failed=0
    trap - ERR INT TERM
    set +e
    sudo cp --preserve=all -- "$backup_dir/index.html.original" "$index_path" || restore_failed=1
    sudo setfacl --restore="$backup_dir/access.acl" || restore_failed=1
    set -e
    if [ "$restore_failed" -ne 0 ]; then
        echo "CRITICAL: an ACL grant failed and automatic restoration was incomplete; keep legacy mode disabled" >&2
        exit 1
    fi
    echo "ACL grant failed; original index.html and ACLs were restored" >&2
    exit "$original_status"
}
trap 'restore_after_partial_grant $?' ERR
trap 'restore_after_partial_grant 130' INT
trap 'restore_after_partial_grant 143' TERM
sudo setfacl -m "u:${service_user}:r" -- "$index_path"
sudo setfacl -m "u:${service_user}:rwx" -- "$index_dir"
trap - ERR INT TERM
```

`getfacl` and `setfacl` must be available. The block stops before mutation unless the content copy is byte-identical and the saved ACL document passes `setfacl --test`. If either narrow grant fails, its error/signal trap restores both the original content and both ACLs before exiting. The file ACE permits the initial read. The non-inherited directory ACE permits the service to create and write the temporary sibling, replace `index.html`, and delete a leftover temporary file. Directory `rwx` also permits manipulating other immediate children, which is the unavoidable Linux directory boundary for an atomic sibling rename; it is not applied recursively.

Keep the printed backup directory. To roll back, disable the legacy setting first and run:

```bash
set -Eeuo pipefail

read -r -p 'Paste the exact Rollback data path: ' backup_dir
[ -f "$backup_dir/access.acl" ] && [ -f "$backup_dir/index.html.original" ] || { echo "Invalid rollback directory" >&2; exit 1; }
sudo test -s "$backup_dir/index.html.original"
test -s "$backup_dir/access.acl"
sudo setfacl --test --restore="$backup_dir/access.acl" >/dev/null
index_path="$(awk '/^# file: / { print substr($0, 9); exit }' "$backup_dir/access.acl")"
[ -n "$index_path" ] || { echo "Rollback ACL data does not name index.html" >&2; exit 1; }
was_running=false
if sudo systemctl is-active --quiet jellyfin; then
    was_running=true
    sudo systemctl stop jellyfin
fi
sudo cp --preserve=all -- "$backup_dir/index.html.original" "$index_path"
sudo setfacl --restore="$backup_dir/access.acl"
if [ "$was_running" = true ]; then sudo systemctl start jellyfin; fi
```

##### Windows native service

Run the whole block in an elevated Windows PowerShell session. It accepts exactly one Windows service whose executable is Jellyfin, records that service's actual **Log On As** principal, resolves an explicit `--webdir` or otherwise requires exactly one `index.html` below the service executable, and saves the original content and SDDL outside the installation tree.

```powershell
$Services = @(Get-CimInstance Win32_Service | Where-Object {
    $_.PathName -match '(?i)(^|[\\/])jellyfin(?:\.exe)?(?:["\s]|$)'
})
if ($Services.Count -ne 1) { throw "Expected exactly one Jellyfin service; found $($Services.Count)." }
$Service = $Services[0]
$Principal = $Service.StartName

if ($Service.PathName -match '^\s*"([^"]+\.exe)"') { $Executable = $Matches[1] }
elseif ($Service.PathName -match '^\s*(\S+\.exe)') { $Executable = $Matches[1] }
else { throw "Could not resolve the Jellyfin service executable." }
$Executable = [Environment]::ExpandEnvironmentVariables($Executable)
$InstallRoot = Split-Path -Parent $Executable

if ($Service.PathName -match '(?i)--webdir(?:=|\s+)(?:"([^"]+)"|(\S+))') {
    $WebDirectory = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
    $WebDirectory = [Environment]::ExpandEnvironmentVariables($WebDirectory)
    if (-not [IO.Path]::IsPathRooted($WebDirectory)) { throw "The service's --webdir is not an absolute path." }
    $Candidates = @(Get-Item -LiteralPath (Join-Path $WebDirectory 'index.html') -ErrorAction Stop)
} else {
    $Candidates = @(Get-ChildItem -LiteralPath $InstallRoot -Filter index.html -File -Recurse -ErrorAction Stop)
}
if ($Candidates.Count -ne 1) { throw "Expected exactly one index.html; found $($Candidates.Count)." }
$IndexPath = $Candidates[0].FullName
$IndexDirectory = $Candidates[0].DirectoryName
$BackupDirectory = Join-Path ([Environment]::GetFolderPath('MyDocuments')) ("JellyfinCanopyIndexBackup-" + (Get-Date -Format 'yyyyMMddTHHmmss'))
New-Item -ItemType Directory -Path $BackupDirectory -ErrorAction Stop | Out-Null
Write-Host "Service principal: $Principal"
Write-Host "Resolved index: $IndexPath"
Write-Host "Rollback data: $BackupDirectory"
$Confirmation = Read-Host 'Review those values, then type YES to add the narrow ACLs'
if ($Confirmation -cne 'YES') { throw 'No permissions changed.' }

$WasRunning = $Service.State -eq 'Running'
if ($WasRunning) { Stop-Service -Name $Service.Name -ErrorAction Stop }
$SafeToRestart = $true
try {
    $BackupPath = Join-Path $BackupDirectory 'index.html.original'
    $StatePath = Join-Path $BackupDirectory 'state.json'
    Copy-Item -LiteralPath $IndexPath -Destination $BackupPath -ErrorAction Stop
    if ((Get-FileHash -LiteralPath $IndexPath).Hash -ne (Get-FileHash -LiteralPath $BackupPath).Hash) {
        throw 'The index.html content backup did not verify.'
    }
    $IndexSddl = (Get-Acl -LiteralPath $IndexPath).Sddl
    $DirectorySddl = (Get-Acl -LiteralPath $IndexDirectory).Sddl
    [ordered]@{
        IndexPath = $IndexPath
        IndexDirectory = $IndexDirectory
        ServiceName = $Service.Name
        Principal = $Principal
        WasRunning = $WasRunning
        IndexSddl = $IndexSddl
        DirectorySddl = $DirectorySddl
    } | ConvertTo-Json | Set-Content -LiteralPath $StatePath -Encoding utf8
    $VerifiedState = Get-Content -LiteralPath $StatePath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    if ($VerifiedState.IndexPath -ne $IndexPath -or $VerifiedState.IndexSddl -ne $IndexSddl `
        -or $VerifiedState.DirectorySddl -ne $DirectorySddl -or $VerifiedState.WasRunning -isnot [bool]) {
        throw 'The ACL rollback state did not verify.'
    }

    $SafeToRestart = $false
    try {
        $FileAcl = Get-Acl -LiteralPath $IndexPath
        $FileRule = [System.Security.AccessControl.FileSystemAccessRule]::new(
            $Principal, [System.Security.AccessControl.FileSystemRights]::Read,
            [System.Security.AccessControl.InheritanceFlags]::None,
            [System.Security.AccessControl.PropagationFlags]::None,
            [System.Security.AccessControl.AccessControlType]::Allow)
        $FileAcl.AddAccessRule($FileRule)
        Set-Acl -LiteralPath $IndexPath -AclObject $FileAcl -ErrorAction Stop

        $DirectoryRights = [System.Security.AccessControl.FileSystemRights]::ReadAndExecute `
            -bor [System.Security.AccessControl.FileSystemRights]::Write `
            -bor [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles
        $DirectoryAcl = Get-Acl -LiteralPath $IndexDirectory
        $DirectoryRule = [System.Security.AccessControl.FileSystemAccessRule]::new(
            $Principal, $DirectoryRights,
            [System.Security.AccessControl.InheritanceFlags]::None,
            [System.Security.AccessControl.PropagationFlags]::None,
            [System.Security.AccessControl.AccessControlType]::Allow)
        $DirectoryAcl.AddAccessRule($DirectoryRule)
        Set-Acl -LiteralPath $IndexDirectory -AclObject $DirectoryAcl -ErrorAction Stop
        $SafeToRestart = $true
    } catch {
        $GrantFailure = $_
        try {
            Copy-Item -LiteralPath $BackupPath -Destination $IndexPath -Force -ErrorAction Stop
            $FileAcl = Get-Acl -LiteralPath $IndexPath
            $FileAcl.SetSecurityDescriptorSddlForm($IndexSddl)
            Set-Acl -LiteralPath $IndexPath -AclObject $FileAcl -ErrorAction Stop
            $DirectoryAcl = Get-Acl -LiteralPath $IndexDirectory
            $DirectoryAcl.SetSecurityDescriptorSddlForm($DirectorySddl)
            Set-Acl -LiteralPath $IndexDirectory -AclObject $DirectoryAcl -ErrorAction Stop
            $SafeToRestart = $true
        } catch {
            Write-Error 'ACL grant failed and automatic restoration was incomplete; keep legacy mode disabled.'
            throw
        }
        throw $GrantFailure
    }
} finally {
    if ($WasRunning -and $SafeToRestart) { Start-Service -Name $Service.Name }
}
```

The file rule is read-only. The non-inherited parent-directory rule supplies the create/write/delete-child operations that the temporary-sibling replace needs, without propagating rights into subdirectories. To roll back, disable the legacy setting, paste the printed backup directory into the first line below, and run the block elevated:

```powershell
$BackupDirectory = Read-Host 'Paste the exact Rollback data path printed by the grant block'
$State = Get-Content -LiteralPath (Join-Path $BackupDirectory 'state.json') -Raw | ConvertFrom-Json
if ($State.WasRunning -isnot [bool]) { throw 'Rollback data does not contain the original service state.' }
$WasRunning = [bool]$State.WasRunning
$Service = Get-Service -Name $State.ServiceName -ErrorAction Stop
if ($Service.Status -eq [System.ServiceProcess.ServiceControllerStatus]::Running) {
    Stop-Service -Name $State.ServiceName -ErrorAction Stop
}
$RestoreSucceeded = $false
try {
    Copy-Item -LiteralPath (Join-Path $BackupDirectory 'index.html.original') -Destination $State.IndexPath -Force -ErrorAction Stop
    $FileAcl = Get-Acl -LiteralPath $State.IndexPath
    $FileAcl.SetSecurityDescriptorSddlForm($State.IndexSddl)
    Set-Acl -LiteralPath $State.IndexPath -AclObject $FileAcl -ErrorAction Stop
    $DirectoryAcl = Get-Acl -LiteralPath $State.IndexDirectory
    $DirectoryAcl.SetSecurityDescriptorSddlForm($State.DirectorySddl)
    Set-Acl -LiteralPath $State.IndexDirectory -AclObject $DirectoryAcl -ErrorAction Stop
    if ((Get-FileHash -LiteralPath $State.IndexPath).Hash -ne (Get-FileHash -LiteralPath (Join-Path $BackupDirectory 'index.html.original')).Hash `
        -or (Get-Acl -LiteralPath $State.IndexPath).Sddl -ne $State.IndexSddl `
        -or (Get-Acl -LiteralPath $State.IndexDirectory).Sddl -ne $State.DirectorySddl) {
        throw 'Restored content or ACL verification failed.'
    }
    $RestoreSucceeded = $true
} finally {
    if ($RestoreSucceeded -and $WasRunning) { Start-Service -Name $State.ServiceName }
}
```

`WasRunning` is captured before the grant block stops anything. Rollback stops a currently running service while it restores, but starts it again only after content and both ACLs verify successfully **and** that saved value was `true`; a service that was originally stopped remains stopped.

##### Docker and other immutable containers

Docker has no supported legacy fallback. Do not copy the package-owned `index.html` out of a container and bind-mount that single file back in: a file mount cannot accept the temporary sibling's atomic rename, and the copied file also drifts from the image on upgrade. Keep `DisableScriptInjectionMiddleware=false` and recreate the container from its original image to discard accidental image-layer changes.

If discovery is ambiguous, an ACL command fails, or the platform cannot express these exact non-recursive rights, leave the request-time middleware enabled.

`index.html` is package-owned and can be replaced by a Jellyfin or `jellyfin-web` upgrade. Before an upgrade, set `DisableScriptInjectionMiddleware` back to `false`, restart, restore the backed-up file (or reinstall/verify the owning package), and remove only the temporary ACL entries you added. Those same steps are the rollback procedure if the fallback fails. Never preserve a modified `index.html` across versions.

### Admin config page tabs not switching

If clicking tabs in the plugin's admin configuration page (Elsewhere, Seerr, *arr, and so on) does nothing, the cause may be **Cloudflare** interfering with JavaScript execution when you reach Jellyfin through a Cloudflare tunnel or proxy.

Try disabling Cloudflare features that modify JavaScript behaviour for your Jellyfin domain:

1. Log in to the [Cloudflare dashboard](https://dash.cloudflare.com).
2. Select your domain.
3. Go to **Speed** → **Optimization** → **Content Optimization**.
4. Toggle **Rocket Loader** off.

If that doesn't help, access the admin config page directly on your local network (bypassing Cloudflare) to confirm whether Cloudflare is the cause. See upstream [Jellyfin Enhanced issue #175](https://github.com/n00bcodr/Jellyfin-Enhanced/issues/175) for more context.

### Still stuck?

1. Check the [FAQ](help.md) for common solutions.
2. Search the [GitHub issues](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues), and open a new one if needed — please include logs and details.
3. Join the [Discord community](https://discord.gg/EYNFf7y4CG).
