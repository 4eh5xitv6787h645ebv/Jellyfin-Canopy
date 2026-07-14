'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

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
 * Builds a small, standards-compliant stored ZIP without external tools.
 * @param {{name: string, data?: string | Buffer}[]} files
 */
function makeZip(files) {
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const file of files) {
        const name = Buffer.from(file.name, 'utf8');
        const data = Buffer.from(file.data || 'fixture');
        const checksum = crc32(data);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(0, 8);
        local.writeUInt32LE(checksum, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        locals.push(local, name, data);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(0, 10);
        central.writeUInt32LE(checksum, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name);
        offset += local.length + name.length + data.length;
    }

    const centralBytes = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(centralBytes.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, centralBytes, eocd]);
}

/** @param {Buffer} bytes */
function checksum(bytes) {
    return crypto.createHash('md5').update(bytes).digest('hex').toUpperCase();
}

/**
 * @param {string} fixturePath
 * @param {{name: string, data?: string | Buffer}[]} files
 */
function writeZipFixture(fixturePath, files) {
    const bytes = makeZip(files);
    fs.writeFileSync(fixturePath, bytes);
    return checksum(bytes);
}

module.exports = { checksum, makeZip, writeZipFixture };
