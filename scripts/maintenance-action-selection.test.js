const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(
    path.join(
        __dirname,
        '..',
        'Jellyfin.Plugin.JellyfinCanopy',
        'Configuration',
        'config-page.js'
    ),
    'utf8'
);

function loadFunction(name, parameters) {
    const match = source.match(
        new RegExp(`function ${name}\\(${parameters}\\) \\{[\\s\\S]*?\\n        \\}`)
    );
    assert.ok(match, `${name} must remain present`);
    return vm.runInNewContext(`(${match[0]})`);
}

function loadSaveOwner(context) {
    const start = source.indexOf('async function persistConfigurationAndMaintenance(config, broadcast)');
    const end = source.indexOf('async function saveConfig(e)', start);
    assert.ok(start >= 0 && end > start, 'the shared save owner must remain present');
    return vm.runInNewContext(`(${source.slice(start, end).trim()})`, context);
}

test('maintenance action selection preserves all four checkbox states', () => {
    const decide = loadFunction('maintenanceActionFromSelections', 'accounts, remote');

    assert.equal(decide(true, true), 'both');
    assert.equal(decide(true, false), 'disable_accounts');
    assert.equal(decide(false, true), 'disable_remote');
    assert.equal(decide(false, false), 'none');
    assert.match(
        source,
        /config\.MaintenanceModeAction = maintenanceActionFromSelections\(mmAccounts, mmRemote\);/,
        'the config save path must use the tested decision function'
    );
});

test('maintenance action reload restores exact checkbox state', () => {
    const selections = loadFunction('maintenanceSelectionsFromAction', 'action');

    assert.deepEqual({ ...selections('both') }, { accounts: true, remote: true });
    assert.deepEqual({ ...selections('disable_accounts') }, { accounts: true, remote: false });
    assert.deepEqual({ ...selections('disable_remote') }, { accounts: false, remote: true });
    assert.deepEqual({ ...selections('none') }, { accounts: false, remote: false });
    assert.deepEqual(
        { ...selections(undefined) },
        { accounts: true, remote: false },
        'an absent legacy value preserves the historic default'
    );
    assert.throws(
        () => selections('future_action'),
        /Unknown maintenance action/,
        'unknown or forward-version values must fail closed instead of rendering as none'
    );
    assert.match(
        source,
        /savedAction = maintenanceSelectionsFromAction\(config\.MaintenanceModeAction\);/,
        'the config load path must use the tested reload function'
    );
});

test('every full-form save uses the shared fail-safe maintenance save owner', () => {
    const saveStart = source.indexOf('async function saveConfig(e)');
    const saveEnd = source.indexOf('// Saves current config and applies it to all users', saveStart);
    const saveSource = source.slice(saveStart, saveEnd);
    const resetStart = source.indexOf('async function resetAllUserSettings()');
    const resetEnd = source.indexOf('// ── Maintenance mode: user checklist', resetStart);
    const resetSource = source.slice(resetStart, resetEnd);

    assert.match(saveSource, /persistConfigurationAndMaintenance\(config, true\)/);
    assert.match(resetSource, /persistConfigurationAndMaintenance\(config, false\)/);
    assert.doesNotMatch(source, /MaintenanceMode\/ApplyConfiguration/);
});

test('the shared save owner uses safety-directed ordering for enable and disable', async () => {
    const enabledCalls = [];
    const enableOwner = loadSaveOwner({
        pluginId: 'plugin',
        getMaintenanceStatus: async () => ({ Phase: 'Inactive', IsActive: false, Action: 'disable_accounts' }),
        enableMaintenanceFromConfig: async () => { enabledCalls.push('enable'); },
        ApiClient: {
            updatePluginConfiguration: async () => { enabledCalls.push('configuration'); return 'saved'; },
            ajax: async () => { enabledCalls.push('unexpected-ajax'); },
            getUrl: value => value
        }
    });
    const enabledResult = await enableOwner({
        MaintenanceModeEnabled: true,
        MaintenanceModeAction: 'none'
    }, false);
    assert.equal(enabledResult, 'saved');
    assert.deepEqual(enabledCalls, ['configuration', 'enable']);

    const disabledCalls = [];
    const disableOwner = loadSaveOwner({
        pluginId: 'plugin',
        getMaintenanceStatus: async () => ({ Phase: 'Active', IsActive: true, Action: 'none' }),
        enableMaintenanceFromConfig: async () => { disabledCalls.push('unexpected-enable'); },
        ApiClient: {
            updatePluginConfiguration: async () => { disabledCalls.push('configuration'); return 'saved'; },
            ajax: async options => { disabledCalls.push(options.url.endsWith('/Disable') ? 'disable' : 'unexpected-ajax'); },
            getUrl: value => value
        }
    });
    const disabledResult = await disableOwner({
        MaintenanceModeEnabled: false,
        MaintenanceModeAction: 'none'
    }, false);
    assert.equal(disabledResult, 'saved');
    assert.deepEqual(disabledCalls, ['disable', 'configuration']);
});

test('the shared save owner fails safe without client-side compensation', async () => {
    const enableCalls = [];
    const responseLossOwner = loadSaveOwner({
        pluginId: 'plugin',
        getMaintenanceStatus: async () => ({ Phase: 'Inactive', IsActive: false, Action: 'disable_accounts' }),
        enableMaintenanceFromConfig: async () => { enableCalls.push('enable'); },
        ApiClient: {
            updatePluginConfiguration: async () => {
                enableCalls.push('configuration-attempt');
                throw new Error('response lost');
            },
            ajax: async () => {},
            getUrl: value => value
        }
    });
    await assert.rejects(
        () => responseLossOwner({ MaintenanceModeEnabled: true, MaintenanceModeAction: 'none' }, false),
        /response lost/
    );
    assert.deepEqual(enableCalls, ['configuration-attempt'], 'a failed/ambiguous config request must not authorize a restriction');

    const disableCalls = [];
    const recoveryFailureOwner = loadSaveOwner({
        pluginId: 'plugin',
        getMaintenanceStatus: async () => ({ Phase: 'Active', IsActive: true, Action: 'none' }),
        enableMaintenanceFromConfig: async () => {},
        ApiClient: {
            updatePluginConfiguration: async () => { disableCalls.push('configuration'); },
            ajax: async () => {
                disableCalls.push('disable-attempt');
                throw new Error('recovery failed');
            },
            getUrl: value => value
        }
    });
    await assert.rejects(
        () => recoveryFailureOwner({ MaintenanceModeEnabled: false, MaintenanceModeAction: 'none' }, false),
        /recovery failed/
    );
    assert.deepEqual(disableCalls, ['disable-attempt'], 'failed recovery must not remove the persisted warning intent');
});

test('the shared save owner rejects active action changes before any write', async () => {
    const calls = [];
    const owner = loadSaveOwner({
        pluginId: 'plugin',
        getMaintenanceStatus: async () => ({ Phase: 'Active', IsActive: true, Action: 'disable_accounts' }),
        enableMaintenanceFromConfig: async () => { calls.push('enable'); },
        ApiClient: {
            updatePluginConfiguration: async () => { calls.push('configuration'); },
            ajax: async () => { calls.push('ajax'); },
            getUrl: value => value
        }
    });
    await assert.rejects(
        () => owner({ MaintenanceModeEnabled: true, MaintenanceModeAction: 'none' }, false),
        /Disable active maintenance before changing its action/
    );
    assert.deepEqual(calls, []);
});
