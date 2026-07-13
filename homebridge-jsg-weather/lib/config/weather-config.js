'use strict';

const {
  DEFAULT_ACCESSORY_NAME,
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_SOURCE_TYPE,
  MIN_INTERVAL_MINUTES,
  MAX_INTERVAL_MINUTES,
} = require('../constants');
const { writeWarning } = require('../logging/log-writer');
const { normalizeMappings } = require('../mappings/mapping-normalizer');

/**
 * <summary>
 * Normalizes the complete public plugin configuration into a stable runtime shape. Only sourceType, source,
 * interval, name, and mappings affect behavior. Every mapping is validated against the selected source format and
 * the plugin's unit catalog before it can cause the single weather accessory to exist.
 * </summary>
 * @param {unknown} rawConfig Configuration block supplied by Homebridge.
 * @param {object} dependencies Required source and unit registries plus logger.
 * @param {object} dependencies.sourceFormatRegistry Registry of implemented source formats.
 * @param {object} dependencies.unitRegistry Registry of implemented compact weather units.
 * @param {object} dependencies.log Homebridge logger or compatible logger.
 * @returns {Readonly<object>} Immutable normalized runtime configuration.
 * @sideEffect Writes concise warnings for unsupported source types and invalid mappings.
 */
function normalizeWeatherConfig(rawConfig, { sourceFormatRegistry, unitRegistry, log }) {
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const sourceType = normalizeSourceType(config.sourceType);
  const formatHandler = sourceFormatRegistry.get(sourceType);

  if (!formatHandler) {
    writeWarning(log, `Weather source type ${sourceType} is not supported`);
  }

  return Object.freeze({
    sourceType,
    source: normalizeString(config.source),
    intervalMinutes: normalizeInterval(config.interval),
    name: normalizeName(config.name),
    mappings: normalizeMappings(config.mappings, {
      unitRegistry,
      formatHandler,
      log,
    }),
  });
}

/**
 * <summary>
 * Normalizes the source format identifier to the lowercase registry convention and applies the JSON default.
 * Unsupported values remain visible to validation rather than being silently converted to JSON.
 * </summary>
 * @param {unknown} value Configured sourceType value.
 * @returns {string} Normalized lowercase source type.
 */
function normalizeSourceType(value) {
  const sourceType = normalizeString(value);
  return sourceType ? sourceType.toLowerCase() : DEFAULT_SOURCE_TYPE;
}

/**
 * <summary>
 * Converts the configured polling interval into a whole number of minutes inside the supported safety range.
 * Invalid, fractional, or out-of-range input uses the documented five-minute default.
 * </summary>
 * @param {unknown} value Configured interval value.
 * @returns {number} Valid polling interval in whole minutes.
 */
function normalizeInterval(value) {
  const interval = Number(value);
  if (
    !Number.isInteger(interval) ||
    interval < MIN_INTERVAL_MINUTES ||
    interval > MAX_INTERVAL_MINUTES
  ) {
    return DEFAULT_INTERVAL_MINUTES;
  }

  return interval;
}

/**
 * <summary>
 * Normalizes the optional accessory display name while preserving user-selected capitalization.
 * </summary>
 * @param {unknown} value Configured accessory display name.
 * @returns {string} Non-empty display name or the documented Weather default.
 */
function normalizeName(value) {
  const name = normalizeString(value);
  return name || DEFAULT_ACCESSORY_NAME;
}

/**
 * <summary>
 * Trims a configurable string while treating non-string values as absent.
 * </summary>
 * @param {unknown} value Candidate string value.
 * @returns {string} Trimmed string or an empty string.
 */
function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

module.exports = {
  normalizeWeatherConfig,
  normalizeSourceType,
  normalizeInterval,
  normalizeName,
};
