'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const contract = require('../Jellyfin.Plugin.JellyfinCanopy/src/theme-studio/jellyfin-web-theme.contract.json');
const { verifySemantics } = require('./check-jellyfin-web-theme-contract');

function exactSources() {
    const imports = Object.keys(contract.builtInThemes)
        .map(name => `import ${name} from './${name}';`)
        .join('\n');
    return {
        'src/themes/index.ts': `${imports}
cssVarPrefix: '${contract.mui.cssVariablePrefix}'
colorSchemeSelector: '${contract.mui.colorSchemeSelector}'
defaultColorScheme: '${contract.mui.defaultColorScheme}'`,
        'src/scripts/themeManager.js': `
document.documentElement.setAttribute('${contract.hostOwnership.themeAttribute}', info.id);
events.trigger(EventType.THEME_CHANGE);`,
        'src/components/ThemeCss.tsx': 'const id = dashboard ? dashboardTheme : theme;',
        'src/scripts/autoThemes.js': `
skinManager.setTheme(userSettings.${contract.hostOwnership.dashboardPreference}());
skinManager.setTheme(userSettings.theme());`,
    };
}

test('official Jellyfin Web theme semantics accept the pinned ownership contract', () => {
    assert.doesNotThrow(() => verifySemantics(contract, exactSources()));
});

test('official Jellyfin Web theme semantics fail closed on MUI or host ownership drift', () => {
    const muiDrift = exactSources();
    muiDrift['src/themes/index.ts'] = muiDrift['src/themes/index.ts']
        .replace("cssVarPrefix: 'jf'", "cssVarPrefix: 'changed'");
    assert.throws(
        () => verifySemantics(contract, muiDrift),
        /src\/themes\/index\.ts no longer contains/,
    );

    const hostDrift = exactSources();
    hostDrift['src/scripts/themeManager.js'] = hostDrift['src/scripts/themeManager.js']
        .replace("setAttribute('data-theme'", "setAttribute('changed-theme'");
    assert.throws(
        () => verifySemantics(contract, hostDrift),
        /src\/scripts\/themeManager\.js no longer contains/,
    );
});

test('official Jellyfin Web built-in theme additions require a reviewed contract update', () => {
    const sources = exactSources();
    sources['src/themes/index.ts'] += "\nimport futuretheme from './futuretheme';";
    assert.throws(
        () => verifySemantics(contract, sources),
        /built-in themes drifted/,
    );
});
