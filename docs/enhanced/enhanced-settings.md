# Enhanced Settings — User configuration

## Enhanced Panel

![Enhanced panel — Settings tab overview](../images/enhanced-panel-settings.png)

Access user-configured settings via the Enhanced panel:

| Shortcuts | Settings |
|-----------|----------|
| ![Shortcuts](../images/enhanced-panel-shortcuts.png) | ![Settings](../images/enhanced-panel-settings.png) |

**Open Panel:**

- Click **Jellyfin Enhanced** in sidebar
- Press `?` keyboard shortcut


**Toggleable User Features:**

- Quality Tags
- Genre Tags
- Language Tags
- Rating Tags
- People Tags
- Pause Screen
- Auto-skip Intros
- Auto Picture-in-Picture
- Review tags
- And more...


**Tabs:**

- **Shortcuts** - Customize keyboard shortcuts
- **Settings** - Enable/disable features, adjust positions

**Settings Persistence:**

- Settings saved to browser localStorage
- Per-user configuration
- Sync across devices (same browser profile)


# Enhanced Settings — Admin configuration

## Feature Toggles

Most features can be enabled/disabled individually:

1. Open Enhanced panel
2. Go to the **Settings** tab
3. Toggle features on/off
4. Changes apply immediately *(no restart needed)*


## Tags: Quality, Genre, Language, Rating, People

### Configuration
1. Open Enhanced panel → `Enhanced Settings`
2. Enable and configure tags you want *(Eg: `Quality Tags`)*
3. Adjust position (top-left, top-right, etc.)

### Hide Tags on Hover
Enable **Hide Tags on Hover** to fade the poster tag overlays (Quality, Genre,
Language, Rating) out while you hover a card, so the artwork and Jellyfin's own
hover buttons stay unobstructed. This applies everywhere those overlays are
drawn — library grids, home rows, similar-items and season rows, the **primary
poster on a detail page**, and **episodes in list view**.

!!! tip

    [Custom CSS available](../advanced/css-customization.md#tags)
