#!/usr/bin/env node

/**
 * Translation Validation and Helper Script
 *
 * This script helps manage translations for Jellyfin Canopy by:
 * - Validating all translation files against the base (en.json)
 * - Detecting missing keys in translations
 * - Finding unused translation keys not referenced in code
 * - Checking for placeholder mismatches
 * - Generating translation templates for maintainers when needed
 *
 * Usage:
 *   node scripts/validate-translations.js [command] [options]
 *
 * Commands:
 *   validate [lang]   - Validate one or all translation files
 *   find-unused       - Find translation keys not used in code
 *   create <lang>     - Create a new translation file template
 *   stats             - Show translation completion statistics
 *   help              - Show this help message
 */

const fs = require('fs');
const path = require('path');

const LOCALES_DIR = path.join(__dirname, '../Jellyfin.Plugin.JellyfinCanopy/js/locales');
const LOCALE_INVENTORY_PATH = path.join(
    __dirname,
    '../Jellyfin.Plugin.JellyfinCanopy/locale-manifest.json'
);
// Translation call sites live in the TypeScript module tree (src/) plus the
// remaining legacy loader files under js/ — scan both.
const CODE_DIRS = [
    path.join(__dirname, '../Jellyfin.Plugin.JellyfinCanopy/src'),
    path.join(__dirname, '../Jellyfin.Plugin.JellyfinCanopy/js'),
];
// ANSI color codes for terminal output
const colors = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m',
    bold: '\x1b[1m'
};

function log(message, color = 'reset') {
    console.log(colors[color] + message + colors.reset);
}

function logError(message) {
    log(`✗ ${message}`, 'red');
}

function logSuccess(message) {
    log(`✓ ${message}`, 'green');
}

function logWarning(message) {
    log(`⚠ ${message}`, 'yellow');
}

function logInfo(message) {
    log(`ℹ ${message}`, 'cyan');
}

/**
 * Load a translation file
 */
function loadTranslation(lang) {
    const filePath = path.join(LOCALES_DIR, `${lang}.json`);
    if (!fs.existsSync(filePath)) {
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        logError(`Failed to parse ${lang}.json: ${error.message}`);
        return null;
    }
}

function readLocaleInventory(inventoryPath = LOCALE_INVENTORY_PATH) {
    return JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
}

/**
 * Compare the canonical supported-locale inventory with the files on disk.
 * Exact spelling matters: Linux can hold both fr.json and FR.json, while other
 * filesystems cannot, so case collisions and case-only renames are hard errors.
 */
function validateLocaleInventory(
    localesDir = LOCALES_DIR,
    inventoryPath = LOCALE_INVENTORY_PATH
) {
    const errors = [];
    let inventory;
    try {
        inventory = readLocaleInventory(inventoryPath);
    } catch (error) {
        return {
            valid: false,
            errors: [`Cannot read locale inventory: ${error.message}`],
            baseLocale: '',
            locales: [],
            files: [],
        };
    }

    const baseLocale = typeof inventory.baseLocale === 'string' ? inventory.baseLocale : '';
    const locales = Array.isArray(inventory.locales) ? inventory.locales : [];
    if (!baseLocale) errors.push('Locale inventory must define baseLocale');
    if (locales.length === 0 || locales.some(code => typeof code !== 'string')) {
        errors.push('Locale inventory must define a non-empty string locales array');
    }

    const validCode = /^[a-z]{2}(?:-[A-Z]{2})?$/;
    for (const code of locales) {
        if (typeof code === 'string' && !validCode.test(code)) {
            errors.push(`Invalid locale code in inventory: ${code}`);
        }
    }
    if (baseLocale && !locales.includes(baseLocale)) {
        errors.push(`Base locale is not registered: ${baseLocale}`);
    }

    const exactCodes = new Set();
    const foldedCodes = new Map();
    for (const code of locales.filter(value => typeof value === 'string')) {
        if (exactCodes.has(code)) errors.push(`Duplicate locale in inventory: ${code}`);
        exactCodes.add(code);
        const folded = code.toLowerCase();
        if (foldedCodes.has(folded) && foldedCodes.get(folded) !== code) {
            errors.push(`Case-colliding locales in inventory: ${foldedCodes.get(folded)} and ${code}`);
        }
        foldedCodes.set(folded, code);
    }
    const sortedLocales = [...locales].sort();
    if (JSON.stringify(locales) !== JSON.stringify(sortedLocales)) {
        errors.push('Locale inventory must remain sorted');
    }

    let files = [];
    try {
        files = fs.readdirSync(localesDir, { withFileTypes: true })
            .filter(entry => entry.isFile() && /\.json$/i.test(entry.name))
            .map(entry => entry.name)
            .sort();
    } catch (error) {
        errors.push(`Cannot read locale directory: ${error.message}`);
    }

    const actualCodes = files.map(file => file.replace(/\.json$/i, ''));
    const actualByFolded = new Map();
    for (const [index, code] of actualCodes.entries()) {
        if (!files[index].endsWith('.json')) {
            errors.push(`Invalid locale filename extension casing: ${files[index]}`);
        }
        const folded = code.toLowerCase();
        if (actualByFolded.has(folded)) {
            errors.push(`Case-colliding locale files: ${actualByFolded.get(folded)}.json and ${code}.json`);
        }
        actualByFolded.set(folded, code);
        if (!validCode.test(code)) errors.push(`Invalid locale filename: ${code}.json`);
    }

    for (const code of locales.filter(value => typeof value === 'string')) {
        if (actualCodes.includes(code)) continue;
        const caseVariant = actualByFolded.get(code.toLowerCase());
        if (caseVariant) {
            errors.push(`Locale filename case mismatch: expected ${code}.json, found ${caseVariant}.json`);
        } else {
            errors.push(`Registered locale file is missing: ${code}.json`);
        }
    }
    for (const code of actualCodes) {
        if (!locales.includes(code) && !foldedCodes.has(code.toLowerCase())) {
            errors.push(`Unregistered locale file: ${code}.json`);
        }
    }

    return { valid: errors.length === 0, errors, baseLocale, locales, files };
}

/**
 * Get all supported translation languages from the canonical inventory.
 */
function getAvailableLanguages() {
    return readLocaleInventory().locales;
}

/**
 * Extract placeholders from a translation string.
 *
 * Two token shapes must stay identical between the base and every locale:
 *   - Icon tokens: `{{icon:name}}` — the FULL token is captured so a dropped,
 *     renamed, or malformed (single-brace `{{icon:name}`) token becomes a
 *     placeholder-set mismatch against the base instead of passing silently.
 *   - Simple params: `{name}` / `{count}` / numbered `{0}`. The colon inside an
 *     icon token stops this pattern, so a well-formed `{{icon:x}}` never yields a
 *     spurious `{x}` hit.
 *
 * Non-string input returns `[]` so callers can't crash on a non-string value.
 */
function extractPlaceholders(text) {
    if (typeof text !== 'string') return [];
    const icons = text.match(/\{\{icon:[a-zA-Z]+\}\}/g) || [];
    const simple = text.match(/\{[a-zA-Z0-9_]+\}/g) || [];
    return [...new Set([...icons, ...simple])].sort();
}

/**
 * Validate a translation object against the base translation object.
 *
 * Pure: no disk access, no logging — it collects and returns errors/warnings so
 * the logic is unit-testable on synthetic in-memory data. Every per-key check
 * (key parity, placeholder parity, empty/non-string values) routes through here.
 *
 * Errors (fail CI): missing keys, missing icon/curly placeholders, empty values,
 * non-string values. Warnings (non-fatal): extra keys, extra placeholders.
 *
 * @param {Record<string, unknown>} baseTranslation - base (en) key/value map
 * @param {Record<string, unknown>} translation - target locale key/value map
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validateEntries(baseTranslation, translation) {
    const errors = [];
    const warnings = [];
    const baseKeys = Object.keys(baseTranslation).sort();
    const translationKeys = Object.keys(translation).sort();

    // Check for missing keys
    const missingKeys = baseKeys.filter(key => !translationKeys.includes(key));
    if (missingKeys.length > 0) {
        errors.push(`Missing ${missingKeys.length} key(s):`);
        missingKeys.forEach(key => {
            errors.push(`  - ${key}`);
        });
    }

    // Check for extra keys
    const extraKeys = translationKeys.filter(key => !baseKeys.includes(key));
    if (extraKeys.length > 0) {
        warnings.push(`Extra ${extraKeys.length} key(s) not in base translation:`);
        extraKeys.forEach(key => {
            warnings.push(`  - ${key}`);
        });
    }

    // Check for placeholder mismatches (icon tokens + simple params). Skip
    // blank/non-string values here — they are reported by the dedicated check
    // below and would otherwise be double-flagged; extractPlaceholders already
    // returns [] for non-strings so there is no crash risk either way.
    baseKeys.forEach(key => {
        const tv = translation[key];
        if (typeof tv !== 'string' || tv.trim() === '') return;

        const basePlaceholders = extractPlaceholders(baseTranslation[key]);
        const translationPlaceholders = extractPlaceholders(tv);

        if (basePlaceholders.length > 0) {
            const missingPlaceholders = basePlaceholders.filter(
                p => !translationPlaceholders.includes(p)
            );
            const extraPlaceholders = translationPlaceholders.filter(
                p => !basePlaceholders.includes(p)
            );

            if (missingPlaceholders.length > 0) {
                errors.push(`Key "${key}" missing placeholders: ${missingPlaceholders.join(', ')}`);
            }
            if (extraPlaceholders.length > 0) {
                warnings.push(`Key "${key}" has extra placeholders: ${extraPlaceholders.join(', ')}`);
            }
        }
    });

    // A present value must be a non-empty string. A non-string value (nested
    // object/array/number/boolean from a Weblate export or hand edit) is a hard
    // error rather than a crash; a blank/whitespace value is a hard error rather
    // than a silent warning.
    translationKeys.forEach(key => {
        const val = translation[key];
        if (val === undefined) return;
        if (typeof val !== 'string') {
            errors.push(`Key "${key}" has a non-string value (${typeof val}); translations must be strings`);
        } else if (val.trim() === '') {
            errors.push(`Key "${key}" has an empty translation`);
        }
    });

    return { errors, warnings };
}

/**
 * Validate a single translation file against base
 */
function validateTranslation(lang, verbose = false) {
    const BASE_LANG = readLocaleInventory().baseLocale;
    if (lang === BASE_LANG) {
        logInfo(`Skipping validation of base language (${BASE_LANG})`);
        return { valid: true, errors: [], warnings: [] };
    }

    const baseTranslation = loadTranslation(BASE_LANG);
    const translation = loadTranslation(lang);

    if (!baseTranslation) {
        logError(`Base translation file (${BASE_LANG}.json) not found!`);
        return { valid: false, errors: ['Base file not found'], warnings: [] };
    }

    if (!translation) {
        logError(`Translation file ${lang}.json not found!`);
        return { valid: false, errors: ['Translation file not found'], warnings: [] };
    }

    const { errors, warnings } = validateEntries(baseTranslation, translation);
    const baseKeyCount = Object.keys(baseTranslation).length;
    const translationKeyCount = Object.keys(translation).length;

    const valid = errors.length === 0;

    if (verbose || !valid || warnings.length > 0) {
        console.log();
        log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, 'gray');
        log(`Validation Results: ${lang}.json`, 'bold');
        log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, 'gray');

        if (valid && warnings.length === 0) {
            logSuccess(`All checks passed! (${translationKeyCount} keys)`);
        } else {
            if (errors.length > 0) {
                logError(`Found ${errors.length} error(s):`);
                errors.forEach(err => console.log(colors.red + err + colors.reset));
            }
            if (warnings.length > 0) {
                logWarning(`Found ${warnings.length} warning(s):`);
                warnings.forEach(warn => console.log(colors.yellow + warn + colors.reset));
            }
        }

        const completion = Math.round((translationKeyCount / baseKeyCount) * 100);
        logInfo(`Completion: ${completion}% (${translationKeyCount}/${baseKeyCount} keys)`);
    }

    return { valid, errors, warnings };
}

/**
 * Find translation keys that are not used in the codebase
 */
function findUnusedKeys() {
    const BASE_LANG = readLocaleInventory().baseLocale;
    const baseTranslation = loadTranslation(BASE_LANG);
    if (!baseTranslation) {
        logError('Base translation file not found!');
        return;
    }

    const allKeys = Object.keys(baseTranslation);
    const usedKeys = new Set();

    // Recursively search for translation key usage in JavaScript files
    function searchDirectory(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        entries.forEach(entry => {
            const filePath = path.join(dir, entry.name);

            if (entry.isDirectory() && entry.name !== 'locales' && entry.name !== 'node_modules') {
                searchDirectory(filePath);
            } else if (entry.isFile() && /\.(js|ts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
                const content = fs.readFileSync(filePath, 'utf8');

                // Call shapes across the TS tree: JC.t('k'), JC.t!('k') (non-null
                // assertion), JC.t?.('k'), plus local aliases t('k') / tWithFallback('k', ...).
                const tMatches = content.matchAll(/(?:(?:JC|window\.JellyfinCanopy)\.t\s*!?\s*(?:\?\.)?|\bt(?:WithFallback)?)\s*\(\s*['"]([^'"]+)['"]/g);
                for (const match of tMatches) {
                    usedKeys.add(match[1]);
                }

                // Match shortcut_ keys used in shortcuts configuration and comparisons
                // e.g., activeShortcuts.OpenSearch, combo === activeShortcuts.GoToHome
                const shortcutMatches = content.matchAll(/activeShortcuts\.([A-Z][a-zA-Z]+)/g);
                for (const match of shortcutMatches) {
                    usedKeys.add(`shortcut_${match[1]}`);
                }

                // Match feature_ and status_ keys used in dynamic translation patterns
                // e.g., JC.t('feature_' + name) or JC.t(`feature_${name}`)
                // Also catch literal strings like 'feature_auto_pause', 'status_enabled'
                const dynamicMatches = content.matchAll(/['"`]((?:feature_|status_|seerr_|elsewhere_)[a-z_]+)['"`]/g);
                for (const match of dynamicMatches) {
                    usedKeys.add(match[1]);
                }

                // Match template literal patterns: `${prefix}_${variable}`
                // This catches cases where keys are built dynamically
                const templateMatches = content.matchAll(/JC\.t\s*\(\s*`([^`]*)\$\{[^}]+\}([^`]*)`/g);
                for (const match of templateMatches) {
                    // Mark keys with dynamic parts as used if they match known patterns
                    const prefix = match[1];
                    if (prefix.match(/^(feature|status|seerr|elsewhere|shortcut)_?$/)) {
                        // Find all keys in translations that start with this prefix
                        allKeys.forEach(key => {
                            if (key.startsWith(prefix)) {
                                usedKeys.add(key);
                            }
                        });
                    }
                }

                // Match keys passed as function parameters
                // e.g., addSettingToggleListener('id', 'setting', 'translation_key')
                const functionParamMatches = content.matchAll(/addSettingToggleListener\s*\([^,]+,\s*[^,]+,\s*['"]([^'"]+)['"]/g);
                for (const match of functionParamMatches) {
                    usedKeys.add(match[1]);
                }

                // Match title/tooltip attributes that use translation keys
                // e.g., title = JC.t('key') or .title = JC.t('key')
                const titleMatches = content.matchAll(/\.title\s*=\s*JC\.t\s*(?:\?\.)?\s*\(\s*['"]([^'"]+)['"]/g);
                for (const match of titleMatches) {
                    usedKeys.add(match[1]);
                }

                // Match textContent assignments
                const textContentMatches = content.matchAll(/\.textContent\s*=\s*JC\.t\s*(?:\?\.)?\s*\(\s*['"]([^'"]+)['"]/g);
                for (const match of textContentMatches) {
                    usedKeys.add(match[1]);
                }
            }
        });
    }

    CODE_DIRS.forEach(dir => { if (fs.existsSync(dir)) searchDirectory(dir); });

    const unusedKeys = allKeys.filter(key => !usedKeys.has(key));

    console.log();
    log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, 'gray');
    log(`Translation Usage Analysis`, 'bold');
    log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, 'gray');
    logInfo(`Total translation keys: ${allKeys.length}`);
    logSuccess(`Used in code: ${usedKeys.size}`);

    if (unusedKeys.length > 0) {
        logWarning(`Potentially unused keys: ${unusedKeys.length}`);
        console.log();
        log(`Keys not found in code (may be dynamically generated):`, 'yellow');
        unusedKeys.forEach(key => {
            console.log(colors.gray + `  - ${key}` + colors.reset);
        });
        console.log();
        logInfo('Note: Some keys might be used dynamically or in templates.');
    } else {
        logSuccess('All translation keys are used in the code!');
    }
}

/**
 * Create a new translation file template
 */
function createTranslationTemplate(lang) {
    const BASE_LANG = readLocaleInventory().baseLocale;
    if (!lang || !/^[a-z]{2}(-[A-Z]{2})?$/.test(lang)) {
        logError('Language code must be ISO 639-1 (e.g., es, fr, de) or with region (e.g., zh-HK, pt-BR)');
        return;
    }

    const filePath = path.join(LOCALES_DIR, `${lang}.json`);

    const baseTranslation = loadTranslation(BASE_LANG);
    if (!baseTranslation) {
        logError('Base translation file not found!');
        return;
    }

    // Create template with empty strings or base values as comments
    const template = {};
    Object.keys(baseTranslation).sort().forEach(key => {
        template[key] = baseTranslation[key]; // Start with English, translator will replace
    });

    try {
        fs.writeFileSync(filePath, JSON.stringify(template, null, 4) + '\n', { encoding: 'utf8', flag: 'wx' });
        const inventory = readLocaleInventory();
        if (!inventory.locales.includes(lang)) {
            inventory.locales.push(lang);
            inventory.locales.sort();
            fs.writeFileSync(LOCALE_INVENTORY_PATH, JSON.stringify(inventory, null, 2) + '\n');
            logInfo(`Registered ${lang} in locale-manifest.json`);
        }
        logSuccess(`Created translation template: ${filePath}`);
        logInfo(`Now edit ${lang}.json and translate the English values to ${lang.toUpperCase()}`);
        logInfo('Run npm run validate-translations, then open a pull request in the Jellyfin Canopy repository.');
    } catch (error) {
        if (error.code === 'EEXIST') {
            logError(`Translation file ${lang}.json already exists!`);
            return;
        }

        throw error;
    }
}

/**
 * Show translation statistics for all languages
 */
function showStats() {
    const BASE_LANG = readLocaleInventory().baseLocale;
    const languages = getAvailableLanguages();
    const baseTranslation = loadTranslation(BASE_LANG);

    if (!baseTranslation) {
        logError('Base translation file not found!');
        return;
    }

    const baseKeyCount = Object.keys(baseTranslation).length;

    console.log();
    log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, 'gray');
    log(`Translation Statistics`, 'bold');
    log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, 'gray');
    console.log();
    log(`Base language: ${BASE_LANG} (${baseKeyCount} keys)`, 'cyan');
    console.log();

    const stats = languages
        .filter(lang => lang !== BASE_LANG)
        .map(lang => {
            const translation = loadTranslation(lang);
            if (!translation) return null;

            const keys = Object.keys(translation);
            const completion = Math.round((keys.length / baseKeyCount) * 100);
            const missingCount = baseKeyCount - keys.length;

            return {
                lang,
                keys: keys.length,
                completion,
                missingCount
            };
        })
        .filter(Boolean)
        .sort((a, b) => b.completion - a.completion);

    console.log('Language | Keys       | Completion | Status');
    console.log('---------|------------|------------|--------');

    stats.forEach(({ lang, keys, completion, missingCount }) => {
        const status = completion === 100 ? colors.green + '✓ Complete' :
                      completion >= 90 ? colors.yellow + '⚠ Almost' :
                      colors.red + '✗ Incomplete';

        console.log(
            `${lang.padEnd(8)} | ` +
            `${keys}/${baseKeyCount}`.padEnd(10) + ` | ` +
            `${completion}%`.padEnd(10) + ` | ` +
            status + colors.reset +
            (missingCount > 0 ? colors.gray + ` (-${missingCount})` + colors.reset : '')
        );
    });

    console.log();
    logInfo(`Total languages: ${stats.length + 1} (including ${BASE_LANG})`);
}

/**
 * Show help message
 */
function showHelp() {
    console.log(`
${colors.bold}Translation Validation and Helper Script${colors.reset}

${colors.cyan}Usage:${colors.reset}
  node scripts/validate-translations.js [command] [options]

${colors.cyan}Commands:${colors.reset}
  ${colors.green}validate [lang]${colors.reset}
      Validate one or all translation files against the base (en.json)
      Examples:
        node scripts/validate-translations.js validate
        node scripts/validate-translations.js validate es

  ${colors.green}find-unused${colors.reset}
      Find translation keys that are not referenced in the JavaScript code
      Example:
        node scripts/validate-translations.js find-unused

  ${colors.green}create <lang>${colors.reset}
    Create a new translation file template for the specified language (maintainer fallback)
      Language can be 2-letter code (pl, es) or region-specific (zh-HK, pt-BR)
      Example:
        node scripts/validate-translations.js create pl
        node scripts/validate-translations.js create zh-HK

  ${colors.green}stats${colors.reset}
      Show translation completion statistics for all languages
      Example:
        node scripts/validate-translations.js stats

  ${colors.green}help${colors.reset}
      Show this help message

${colors.cyan}Examples:${colors.reset}
    # Preferred translator workflow
    Edit the locale JSON file, run npm run validate-translations, and open a pull request

  # Validate all translations
  node scripts/validate-translations.js validate

  # Validate Spanish translation only
  node scripts/validate-translations.js validate es

  # Find unused translation keys
  node scripts/validate-translations.js find-unused

  # Create new Polish translation
  node scripts/validate-translations.js create pl

  # Create new Traditional Chinese (Hong Kong) translation
  node scripts/validate-translations.js create zh-HK

  # Show statistics
  node scripts/validate-translations.js stats
`);
}

/**
 * Main execution
 */
function main() {
    const args = process.argv.slice(2);
    const command = args[0] || 'help';

    switch (command) {
        case 'validate': {
            const inventory = validateLocaleInventory();
            if (!inventory.valid) {
                inventory.errors.forEach(error => logError(error));
                process.exit(1);
            }
            const targetLang = args[1];
            if (targetLang && !inventory.locales.includes(targetLang)) {
                logError(`Locale is not registered in locale-manifest.json: ${targetLang}`);
                process.exit(1);
            }
            const languages = targetLang
                ? [targetLang]
                : inventory.locales.filter(lang => lang !== inventory.baseLocale);

            if (languages.length === 0) {
                logError('No translation files found!');
                process.exit(1);
            }

            let allValid = true;
            languages.forEach(lang => {
                const result = validateTranslation(lang, true);
                if (!result.valid) {
                    allValid = false;
                }
            });

            if (!allValid) {
                console.log();
                logError('Some translations have errors!');
                process.exit(1);
            } else {
                console.log();
                logSuccess('All translations are valid!');
            }
            break;
        }

        case 'find-unused':
            findUnusedKeys();
            break;

        case 'create':
            if (!args[1]) {
                logError('Please specify a language code (e.g., pl, ru, ja)');
                showHelp();
                process.exit(1);
            }
            createTranslationTemplate(args[1]);
            break;

        case 'stats':
            showStats();
            break;

        case 'help':
        default:
            showHelp();
            break;
    }
}

// Run if called directly
if (require.main === module) {
    main();
}

module.exports = {
    extractPlaceholders,
    validateEntries,
    validateTranslation,
    findUnusedKeys,
    createTranslationTemplate,
    showStats,
    getAvailableLanguages,
    readLocaleInventory,
    validateLocaleInventory
};
