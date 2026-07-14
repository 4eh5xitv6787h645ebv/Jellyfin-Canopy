'use strict';

// @ts-check

const zlib = require('node:zlib');

const MAX_UNCOMPRESSED_DLL_BYTES = 128 * 1024 * 1024;

/** @param {Buffer} bytes */
function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) {
            crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Derives the assembly filename from the release ZIP convention.
 * @param {string} zipName
 * @param {string} targetAbi
 * @returns {string | null}
 */
function expectedDllFromZipName(zipName, targetAbi) {
    const abi = targetAbi.split('.').slice(0, 3).join('.');
    const suffix = `_${abi}.zip`;
    return abi && zipName.endsWith(suffix)
        ? `${zipName.slice(0, -suffix.length)}.dll`
        : null;
}

/**
 * Reads a ZIP central directory without extracting untrusted content and
 * enforces Jellyfin's plugin-package contract: exactly one DLL at the root.
 * @param {Buffer} bytes
 * @param {string | null} [expectedDll]
 * @returns {{ok: boolean, entries: string[], error?: string}}
 */
function inspectZipLayout(bytes, expectedDll = null) {
    const eocdSignature = 0x06054b50;
    const centralSignature = 0x02014b50;
    const minimumEocd = 22;
    const searchStart = Math.max(0, bytes.length - 65_557);
    let eocd = -1;

    for (let offset = bytes.length - minimumEocd; offset >= searchStart; offset--) {
        if (bytes.readUInt32LE(offset) === eocdSignature) {
            eocd = offset;
            break;
        }
    }
    if (eocd < 0) return { ok: false, entries: [], error: 'not a readable ZIP (EOCD missing)' };

    const disk = bytes.readUInt16LE(eocd + 4);
    const centralDisk = bytes.readUInt16LE(eocd + 6);
    const entriesOnDisk = bytes.readUInt16LE(eocd + 8);
    const entryCount = bytes.readUInt16LE(eocd + 10);
    const centralSize = bytes.readUInt32LE(eocd + 12);
    const centralOffset = bytes.readUInt32LE(eocd + 16);
    const commentLength = bytes.readUInt16LE(eocd + 20);
    if (eocd + minimumEocd + commentLength !== bytes.length) {
        return { ok: false, entries: [], error: 'ZIP end record does not match the file length' };
    }
    if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
        return { ok: false, entries: [], error: 'multi-disk ZIPs are not supported' };
    }
    if (entryCount === 0 || entryCount === 0xffff
        || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
        return { ok: false, entries: [], error: 'empty or ZIP64 package is not allowed' };
    }
    if (centralOffset + centralSize > eocd || centralOffset > bytes.length) {
        return { ok: false, entries: [], error: 'central directory is out of bounds' };
    }

    const entries = [];
    let cursor = centralOffset;
    for (let index = 0; index < entryCount; index++) {
        if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== centralSignature) {
            return { ok: false, entries, error: 'central directory entry is truncated or invalid' };
        }
        const nameLength = bytes.readUInt16LE(cursor + 28);
        const extraLength = bytes.readUInt16LE(cursor + 30);
        const entryCommentLength = bytes.readUInt16LE(cursor + 32);
        const flags = bytes.readUInt16LE(cursor + 8);
        const compressionMethod = bytes.readUInt16LE(cursor + 10);
        const expectedCrc = bytes.readUInt32LE(cursor + 16);
        const compressedSize = bytes.readUInt32LE(cursor + 20);
        const uncompressedSize = bytes.readUInt32LE(cursor + 24);
        const localOffset = bytes.readUInt32LE(cursor + 42);
        const next = cursor + 46 + nameLength + extraLength + entryCommentLength;
        if (nameLength === 0 || next > bytes.length || next > centralOffset + centralSize) {
            return { ok: false, entries, error: 'central directory filename is out of bounds' };
        }
        const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
        if (name.includes('\0')) {
            return { ok: false, entries, error: 'ZIP filename contains a NUL byte' };
        }
        if ((flags & 0x0001) !== 0) {
            return { ok: false, entries, error: 'encrypted ZIP entries are not allowed' };
        }
        if (compressionMethod !== 0 && compressionMethod !== 8) {
            return { ok: false, entries, error: `unsupported ZIP compression method ${compressionMethod}` };
        }
        if (uncompressedSize > MAX_UNCOMPRESSED_DLL_BYTES) {
            return {
                ok: false,
                entries,
                error: `uncompressed DLL exceeds ${MAX_UNCOMPRESSED_DLL_BYTES} bytes`,
            };
        }
        if (localOffset + 30 > centralOffset || bytes.readUInt32LE(localOffset) !== 0x04034b50) {
            return { ok: false, entries, error: 'local ZIP header is missing or out of bounds' };
        }
        const localNameLength = bytes.readUInt16LE(localOffset + 26);
        const localExtraLength = bytes.readUInt16LE(localOffset + 28);
        const localMethod = bytes.readUInt16LE(localOffset + 8);
        const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
        if (dataOffset + compressedSize > centralOffset) {
            return { ok: false, entries, error: 'compressed ZIP data is out of bounds' };
        }
        const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8');
        if (localName !== name) {
            return { ok: false, entries, error: 'local and central ZIP filenames disagree' };
        }
        if (localMethod !== compressionMethod) {
            return { ok: false, entries, error: 'local and central ZIP compression methods disagree' };
        }
        const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
        let uncompressed;
        try {
            uncompressed = compressionMethod === 0
                ? compressed
                : zlib.inflateRawSync(compressed, { maxOutputLength: MAX_UNCOMPRESSED_DLL_BYTES });
        } catch (error) {
            return {
                ok: false,
                entries,
                error: `DLL data cannot be decompressed: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
        if (uncompressed.length !== uncompressedSize) {
            return { ok: false, entries, error: 'uncompressed DLL size does not match the ZIP directory' };
        }
        if (crc32(uncompressed) !== expectedCrc) {
            return { ok: false, entries, error: 'DLL CRC does not match the ZIP directory' };
        }
        entries.push(name);
        cursor = next;
    }
    if (cursor !== centralOffset + centralSize) {
        return { ok: false, entries, error: 'central directory size does not match its entries' };
    }

    const exactRootDll = entries.length === 1
        && !entries[0].includes('/')
        && !entries[0].includes('\\')
        && /^[^/\\]+\.dll$/i.test(entries[0]);
    if (!exactRootDll) {
        return {
            ok: false,
            entries,
            error: `expected exactly one root DLL, found: ${entries.join(', ') || '(none)'}`,
        };
    }
    if (expectedDll !== null && entries[0] !== expectedDll) {
        return {
            ok: false,
            entries,
            error: `expected root DLL ${expectedDll}, found ${entries[0]}`,
        };
    }
    return { ok: true, entries };
}

module.exports = { expectedDllFromZipName, inspectZipLayout };
