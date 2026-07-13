'use strict';

/**
 * <summary>
 * Defines the three supported unit-level automation contracts. Numeric output supports numeric comparisons,
 * discrete output supports exact-value comparisons, and informational output remains readable without events.
 * These values are internal unit metadata and never become user-configurable mapping properties.
 * </summary>
 */
const WEATHER_UNIT_AUTOMATION_KINDS = Object.freeze({
  NUMERIC: 'numeric',
  DISCRETE: 'discrete',
  INFORMATIONAL: 'informational',
});

/**
 * <summary>
 * Stores the complete immutable HomeKit permission set for every automation contract. All weather values remain
 * read-only; numeric and discrete values publish events, while informational values provide paired reads only.
 * </summary>
 */
const WEATHER_UNIT_AUTOMATION_PERMISSIONS = Object.freeze({
  [WEATHER_UNIT_AUTOMATION_KINDS.NUMERIC]: Object.freeze(['pr', 'ev']),
  [WEATHER_UNIT_AUTOMATION_KINDS.DISCRETE]: Object.freeze(['pr', 'ev']),
  [WEATHER_UNIT_AUTOMATION_KINDS.INFORMATIONAL]: Object.freeze(['pr']),
});

/**
 * <summary>
 * Determines whether a candidate is one of the plugin-owned automation classifications. Keeping this check in the
 * unit subsystem prevents configuration or provider code from inventing additional automation behavior.
 * </summary>
 * @param {unknown} value Candidate automation classification.
 * @returns {boolean} True when the candidate is a supported internal automation kind.
 */
function isWeatherUnitAutomationKind(value) {
  return Object.prototype.hasOwnProperty.call(WEATHER_UNIT_AUTOMATION_PERMISSIONS, value);
}

/**
 * <summary>
 * Retrieves the immutable HomeKit permissions assigned to one validated unit automation classification. The result
 * never contains paired-write permission, so mapped source values cannot be changed through HomeKit.
 * </summary>
 * @param {string} automationKind Valid internal unit automation classification.
 * @returns {ReadonlyArray<string>} Frozen HAP permission list for the requested classification.
 * @throws {TypeError} When the supplied classification is unsupported.
 */
function getWeatherUnitAutomationPermissions(automationKind) {
  if (!isWeatherUnitAutomationKind(automationKind)) {
    throw new TypeError(`Unsupported weather unit automation kind: ${String(automationKind)}`);
  }

  return WEATHER_UNIT_AUTOMATION_PERMISSIONS[automationKind];
}

module.exports = {
  WEATHER_UNIT_AUTOMATION_KINDS,
  WEATHER_UNIT_AUTOMATION_PERMISSIONS,
  isWeatherUnitAutomationKind,
  getWeatherUnitAutomationPermissions,
};
