# Installation Guide

<!-- use a custom title -->
!!! info "Prerequisites"

    **Prerequisites:**

    - Jellyfin server version 12.x
    - Admin access to your Jellyfin server
    - Modern web browser (Chrome, Firefox, Edge, Safari)

    On Jellyfin 10.11? Stay on the plugin's final 11.x release — see [Migrating to v12](migrating-to-v12.md).


## Standard Installation

### Step 1: Add Plugin Repository

1. In Jellyfin, navigate to **Dashboard** → **Plugins** → **Manage Repositories**
2. Click **➕** (Add button) to add a new repository
3. Give the repository a name (e.g., "Jellyfin Elevate")
4. Set the **Repository URL** to the manifest:
   ```
   https://raw.githubusercontent.com/n00bcodr/jellyfin-plugins/main/10.11/manifest.json
   ```

5. Click **Save**

### Step 2: Install Plugin

1. Go to the **All** tab
2. Find **Jellyfin Elevate** in the plugin list
3. Click **Install**
4. Wait for the installation to complete

### Step 3: Install File Transformation Plugin (Optional)

<!-- use a custom title -->
!!! info "When you need this"

    In Jellyfin 12, Jellyfin Elevate injects its client `<script>` at request time through ASP.NET middleware, so a default install **never modifies `index.html` on disk** and cannot produce `index.html` permission errors from JE's script injection. You do **not** need the File Transformation plugin for JE to work.

    Install the [File Transformation plugin](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) only if you want to use the optional **Custom Tabs / Plugin Pages** integrations, which rely on it to register their pages.

To add it:

1. In the **All** tab, search for "file-transformation"
2. Install the **File Transformation** plugin
3. Restart your Jellyfin server

### Step 4: Restart Server

1. **Restart** your Jellyfin server to complete the installation *(This is required for the plugin to take effect)*

### Step 5: Verify Installation

After restart:

1. Refresh your browser *(`Ctrl+F5` or `Cmd+Shift+R`)*
2. Access the Jellyfin Elevate settings panel. Options:
    - In the sidebar, under the **Jellyfin Elevate** heading: click **Enhanced Panel**
    - Press `?`
3. If you see the panel, installation was successful!