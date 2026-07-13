'use strict';

const { writeWarning, formatError } = require('../logging/log-writer');
const { createMappingKey } = require('./mapping-identity');

/**
 * <summary>
 * Converts user mappings into the immutable runtime representation used by polling and HomeKit reconciliation.
 * Every mapping supplies its own visible name, one plugin-supported compact unit, and one source-format path. The
 * same unit may occur repeatedly under different names; only an identical normalized name-and-unit identity is a
 * duplicate. Invalid entries are skipped independently so one user error cannot disable other readings.
 * </summary>
 * @param {unknown} rawMappings Configured mappings value.
 * @param {object} options Required registry, selected source-format handler, and logger.
 * @param {object} options.unitRegistry Registry of plugin-owned unit presentation definitions.
 * @param {object|undefined} options.formatHandler Handler selected by sourceType.
 * @param {object} options.log Homebridge logger or compatible logger.
 * @returns {ReadonlyArray<{key: string, name: string, unit: string, path: string}>} Valid mappings in configuration order.
 * @sideEffect Writes warnings for invalid entries without logging source documents or resolved values.
 */
function normalizeMappings(rawMappings, { unitRegistry, formatHandler, log }) {
  if (!Array.isArray(rawMappings)) {
    if (rawMappings !== undefined) {
      writeWarning(log, 'Weather mappings must be an array and were ignored');
    }
    return Object.freeze([]);
  }

  const mappings = [];
  const mappedKeys = new Set();

  for (let index = 0; index < rawMappings.length; index += 1) {
    const mapping = rawMappings[index];

    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
      writeWarning(log, `Weather mapping ${index + 1} must be an object and was ignored`);
      continue;
    }

    const name = normalizeString(mapping.name);
    const unit = normalizeString(mapping.unit);
    const path = normalizeString(mapping.path);

    if (!name || !unit || !path) {
      writeWarning(log, `Weather mapping ${index + 1} requires name, unit, and path and was ignored`);
      continue;
    }

    if (!unitRegistry.has(unit)) {
      writeWarning(log, `Weather mapping ${index + 1} uses unsupported unit ${unit} and was ignored`);
      continue;
    }

    if (!formatHandler) {
      writeWarning(log, `Weather mapping ${index + 1} cannot be validated for the selected source type and was ignored`);
      continue;
    }

    try {
      formatHandler.validatePath(path);
    } catch (error) {
      writeWarning(log, `Weather mapping ${index + 1} has an invalid path and was ignored: ${formatError(error)}`);
      continue;
    }

    const key = createMappingKey(name, unit);
    if (mappedKeys.has(key)) {
      writeWarning(log, `Weather mapping ${index + 1} duplicates name ${name} with unit ${unit} and was ignored`);
      continue;
    }

    mappedKeys.add(key);
    mappings.push(Object.freeze({ key, name, unit, path }));
  }

  return Object.freeze(mappings);
}

/**
 * <summary>
 * Trims a configurable measurement name, unit, or source path while treating non-string values as absent. Unit
 * capitalization and symbols remain unchanged because scientific unit identifiers are case-sensitive contracts.
 * </summary>
 * @param {unknown} value Candidate string value.
 * @returns {string} Trimmed string or an empty string when absent.
 */
function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

module.exports = {
  normalizeMappings,
};
