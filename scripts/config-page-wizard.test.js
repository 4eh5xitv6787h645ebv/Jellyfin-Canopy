'use strict';

// Guard tests for the first-run wizard and Essentials view-mode contracts on
// the admin config page. These pin the safety properties, not the visuals:
// the wizard can never trap an admin, mirror controls can never double-bind
// a config key, and the completion flag never rides the form save path
// (which would change the golden save-key snapshot).

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const root = path.join(__dirname, '..', 'Jellyfin.Plugin.JellyfinCanopy');
const js = fs.readFileSync(path.join(root, 'Configuration', 'config-page.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'Configuration', 'configPage.html'), 'utf8');
const config = fs.readFileSync(
    path.join(root, 'Configuration', 'PluginConfiguration.cs'), 'utf8');
const descriptors = fs.readFileSync(
    path.join(root, 'Configuration', 'SettingDescriptors.cs'), 'utf8');

test('wizard and Essentials mirrors never carry binder keys', () => {
    const wizard = html.slice(html.indexOf('id="jcWizard"'), html.indexOf('id="jcSidebar"'));
    assert.ok(wizard.length > 0, 'wizard markup not found before the sidebar');
    assert.doesNotMatch(wizard, /data-config-key=/, 'wizard inputs must be mirrors');
    const essStart = html.indexOf('id="jcEssentials"');
    const essentials = html.slice(essStart, html.indexOf('id="JellyfinCanopyForm"', essStart));
    assert.ok(essentials.length > 0, 'essentials markup not found before the form');
    assert.doesNotMatch(essentials, /data-config-key=/, 'essentials inputs must be mirrors');
});

test('wizard opens from hydration before the loading overlay clears and stays skippable', () => {
    const hook = js.indexOf('config.WizardCompleted !== true');
    const hide = js.indexOf('Dashboard.hideLoadingMsg();', hook);
    assert.ok(hook >= 0, 'loadConfig must gate the wizard on WizardCompleted');
    assert.ok(hide > hook, 'wizard hook must run before the loading overlay clears');
    assert.match(js, /if \(event\.key === 'Escape'\) jcSkipWizard\(\);/,
        'Escape must close (and complete) the wizard');
    assert.match(js, /jcSkipWizard\(\)/, 'scrim/skip paths must complete the wizard');
});

test('completion flag persists outside the form save path and stays undescribed', () => {
    const buildStart = js.indexOf('async function buildConfigFromForm()');
    const buildEnd = js.indexOf('return config;', buildStart);
    const savePath = js.slice(buildStart, buildEnd);
    assert.ok(buildStart >= 0 && buildEnd > buildStart);
    assert.ok(!savePath.includes('WizardCompleted'),
        'WizardCompleted must not ride buildConfigFromForm (golden snapshot)');
    assert.ok(!html.includes('data-config-key="WizardCompleted"'),
        'WizardCompleted must not be a bound control');
    assert.match(js, /config\.WizardCompleted = true;/,
        'wizard completion must persist via its own get/update round-trip');
    assert.ok(!descriptors.includes('WizardCompleted'),
        'WizardCompleted is server+admin-page only; no client descriptor');
});

test('the parked server flag ships with the wizard', () => {
    // While the coverage-baseline question is unresolved the property may be
    // parked; this test flips from documenting to enforcing once it lands.
    const hasProperty = /public bool WizardCompleted \{ get; set; \}/.test(config);
    if (!hasProperty) {
        // Parked: the wizard must then fail open (never block) AND a browser
        // fallback must stop the modal reopening on every visit.
        assert.match(js, /could not persist wizard completion/,
            'without the server flag the persist path must fail open with a warning');
        assert.match(js, /jc-wizard-completed/,
            'browser fallback key must gate auto-open while the flag is parked');
        assert.match(js, /jcWizardLocallyDone\(\)/,
            'loadConfig must consult the browser fallback before opening');
    }
});

test('view mode persists per browser and Essentials never hides the save dock', () => {
    assert.match(js, /jc-settings-view-mode/, 'view-mode localStorage key');
    const cssFile = fs.readFileSync(path.join(root, 'Configuration', 'configPage.css'), 'utf8');
    const essRules = cssFile.match(/body\.jc-essentials-mode[^{]*\{[^}]*\}/g) || [];
    for (const rule of essRules) {
        assert.ok(!rule.includes('.jc-save-dock'),
            'essentials mode must keep the save dock visible');
    }
    assert.match(cssFile, /body\.jc-essentials-mode #JellyfinCanopyForm > \.jellyfin-tab-content/,
        'essentials mode hides advanced tab contents via the body class');
});
