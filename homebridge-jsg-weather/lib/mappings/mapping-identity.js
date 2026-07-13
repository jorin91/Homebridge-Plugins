'use strict';

const { createHash } = require('node:crypto');

const MAPPING_KEY_HEX_LENGTH = 32;

/**
 * <summary>
 * Derives a compact deterministic internal key from the normalized mapping name and unit. The source path is
 * deliberately excluded so changing providers or correcting a JSON path reuses the existing HomeKit service. The
 * key is never exposed in configuration and contains no raw user text or unit punctuation.
 * </summary>
 * @param {string} name Normalized user-selected measurement name.
 * @param {string} unit Exact compact unit identifier.
 * @returns {string} Lowercase hexadecimal internal mapping identity.
 */
function createMappingKey(name, unit) {
  return createHash('sha256')
    .update(unit, 'utf8')
    .update('\0', 'utf8')
    .update(name, 'utf8')
    .digest('hex')
    .slice(0, MAPPING_KEY_HEX_LENGTH);
}

module.exports = {
  createMappingKey,
  MAPPING_KEY_HEX_LENGTH,
};
