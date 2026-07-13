'use strict';

const {
  normalizeFiniteNumber,
  normalizeInteger,
  normalizeIso8601,
} = require('./unit-value-normalizers');
const {
  DUTCH_COMPASS_16_DIRECTIONS,
  normalizeCompass16Direction,
  normalizeDegreeDirection,
  convertCompass16ToDegrees,
  convertDegreesToCompass16,
} = require('./wind-direction-converters');
const { WEATHER_UNIT_AUTOMATION_KINDS } = require('./weather-unit-automation');

/**
 * <summary>
 * Builds the complete provider-neutral two-digit WMO present-weather code range together with the plugin's explicit
 * unavailable value. A loop keeps the contract auditable without maintaining a long error-prone literal list.
 * </summary>
 * @returns {ReadonlyArray<number>} Frozen list containing -1 followed by every integer from 0 through 99.
 */
function createWmoWeatherCodes() {
  const codes = [-1];
  for (let code = 0; code <= 99; code += 1) {
    codes.push(code);
  }

  return Object.freeze(codes);
}

/**
 * <summary>
 * Lists the plugin neutral code and the complete provider-neutral two-digit WMO present-weather code range.
 * </summary>
 */
const WMO_WEATHER_CODES = createWmoWeatherCodes();

/**
 * <summary>
 * Lists the readable unavailable state and every canonical Dutch 16-point compass label. The same list governs
 * direct compass output and degree-to-compass conversion so exact-value automation conditions stay consistent.
 * </summary>
 */
const COMPASS_16_DISCRETE_VALUES = Object.freeze([
  'Unavailable',
  ...DUTCH_COMPASS_16_DIRECTIONS,
]);

/**
 * <summary>
 * Creates one immutable floating-point unit definition. Numeric definitions preserve the raw number for HomeKit
 * comparisons and keep the compact unit symbol in characteristic metadata instead of appending it to the value.
 * </summary>
 * @param {string} unit Compact unit identifier used in public mapping configuration.
 * @param {object} options Unit-specific HomeKit presentation and fallback options.
 * @param {string} [options.homeKitUnit=unit] Unit string sent through HAP; native HAP names are used where defined.
 * @param {number} [options.neutralValue=-1] Explicit finite fallback for missing or invalid source values.
 * @param {number} [options.minValue=-1] Lowest value accepted by the custom characteristic.
 * @param {number} [options.maxValue=1000000000] Highest value accepted by the custom characteristic.
 * @param {number} [options.minStep=0.01] Smallest advertised numeric increment.
 * @returns {Readonly<object>} Frozen floating-point weather unit definition.
 */
function createFloatDefinition(unit, options = {}) {
  return Object.freeze({
    unit,
    automationKind: WEATHER_UNIT_AUTOMATION_KINDS.NUMERIC,
    format: 'float',
    homeKitUnit: options.homeKitUnit || unit,
    neutralValue: options.neutralValue ?? -1,
    minValue: options.minValue ?? -1,
    maxValue: options.maxValue ?? 1000000000,
    minStep: options.minStep ?? 0.01,
    normalize: normalizeFiniteNumber,
  });
}

/**
 * <summary>
 * Creates the immutable direct-degree direction definition. Raw provider values are constrained to 0 through 360,
 * while -1 remains reserved exclusively for the explicit unavailable state published by the service manager.
 * </summary>
 * @returns {Readonly<object>} Frozen direct-degree weather unit definition.
 */
function createDegreeDefinition() {
  return Object.freeze({
    unit: '°',
    automationKind: WEATHER_UNIT_AUTOMATION_KINDS.NUMERIC,
    format: 'float',
    homeKitUnit: 'arcdegrees',
    neutralValue: -1,
    minValue: -1,
    maxValue: 360,
    minStep: 1,
    normalize: normalizeDegreeDirection,
  });
}

/**
 * <summary>
 * Creates the immutable ISO 8601 informational definition used for date and date-time values. It is readable in
 * HomeKit but deliberately does not publish value-change events because free-form timestamps are not a logical
 * fixed-set or numeric automation input.
 * </summary>
 * @returns {Readonly<object>} Frozen ISO 8601 informational unit definition.
 */
function createIso8601Definition() {
  return Object.freeze({
    unit: 'iso8601',
    automationKind: WEATHER_UNIT_AUTOMATION_KINDS.INFORMATIONAL,
    format: 'string',
    homeKitUnit: 'iso8601',
    neutralValue: 'Unavailable',
    maxLength: 64,
    normalize: normalizeIso8601,
  });
}

/**
 * <summary>
 * Creates one immutable discrete compass definition for direct or converted 16-point output. Both definitions
 * normalize to the exact canonical Dutch value set and publish events for exact equality conditions in compatible
 * HomeKit clients; the string set remains internal because HAP validValues metadata accepts numbers only.
 * </summary>
 * @param {string} unit Public unit key describing the direct or converting source contract.
 * @param {Function} normalize Unit-specific direction normalizer or converter.
 * @returns {Readonly<object>} Frozen compass-text weather unit definition.
 */
function createCompassTextDefinition(unit, normalize) {
  return Object.freeze({
    unit,
    automationKind: WEATHER_UNIT_AUTOMATION_KINDS.DISCRETE,
    discreteValues: COMPASS_16_DISCRETE_VALUES,
    format: 'string',
    homeKitUnit: 'compass16',
    neutralValue: 'Unavailable',
    maxLength: 11,
    normalize,
  });
}

/**
 * <summary>
 * Creates the immutable compass-to-degrees conversion definition. Compass sector centers include half degrees, so
 * the HomeKit characteristic advertises a 0.5-degree step while retaining -1 as its explicit unavailable value.
 * </summary>
 * @returns {Readonly<object>} Frozen compass-to-degrees weather unit definition.
 */
function createCompassToDegreesDefinition() {
  return Object.freeze({
    unit: 'compass16->°',
    automationKind: WEATHER_UNIT_AUTOMATION_KINDS.NUMERIC,
    format: 'float',
    homeKitUnit: 'arcdegrees',
    neutralValue: -1,
    minValue: -1,
    maxValue: 360,
    minStep: 0.5,
    normalize: convertCompass16ToDegrees,
  });
}

/**
 * <summary>
 * Creates the immutable discrete WMO code definition. Its numeric fixed set contains the plugin's -1 neutral state
 * and every provider-neutral two-digit WMO present-weather code, allowing HAP validValues metadata and exact-value
 * automation conditions without treating the code as a continuous measurement.
 * </summary>
 * @returns {Readonly<object>} Frozen signed-integer WMO unit definition.
 */
function createWmoDefinition() {
  return Object.freeze({
    unit: 'WMO',
    automationKind: WEATHER_UNIT_AUTOMATION_KINDS.DISCRETE,
    discreteValues: WMO_WEATHER_CODES,
    format: 'int',
    homeKitUnit: 'WMO',
    neutralValue: -1,
    minValue: -1,
    maxValue: 99,
    minStep: 1,
    normalize: normalizeInteger,
  });
}

/**
 * <summary>
 * Defines the complete ordered production catalog of physical units, compass representations, and conversions.
 * Every definition owns its automation classification so mappings require no additional automation property.
 * </summary>
 */
const DEFAULT_WEATHER_UNIT_DEFINITIONS = Object.freeze([
  createFloatDefinition('1', {
    neutralValue: -9999,
    minValue: -1000000000,
  }),
  createFloatDefinition('%', {
    homeKitUnit: 'percentage',
    minValue: -1,
    maxValue: 100,
  }),
  createDegreeDefinition(),
  createCompassTextDefinition('compass16', normalizeCompass16Direction),
  createCompassToDegreesDefinition(),
  createCompassTextDefinition('°->compass16', convertDegreesToCompass16),
  createFloatDefinition('°C', {
    homeKitUnit: 'celsius',
    neutralValue: -273.15,
    minValue: -273.15,
    maxValue: 1000,
  }),
  createFloatDefinition('°F', {
    neutralValue: -459.67,
    minValue: -459.67,
    maxValue: 1832,
  }),
  createFloatDefinition('cm'),
  createFloatDefinition('GGDc'),
  createFloatDefinition('h'),
  createFloatDefinition('hPa'),
  createFloatDefinition('in'),
  createIso8601Definition(),
  createFloatDefinition('J/kg', {
    neutralValue: -9999,
    minValue: -1000000000,
  }),
  createFloatDefinition('kg/m²'),
  createFloatDefinition('km/h'),
  createFloatDefinition('kn'),
  createFloatDefinition('kPa'),
  createFloatDefinition('m'),
  createFloatDefinition('m/s'),
  createFloatDefinition('m³/m³', {
    minValue: -1,
    maxValue: 1,
  }),
  createFloatDefinition('MJ/m²'),
  createFloatDefinition('mm'),
  createFloatDefinition('mph'),
  createFloatDefinition('ms'),
  createFloatDefinition('s', {
    homeKitUnit: 'seconds',
  }),
  createFloatDefinition('W/m²'),
  createWmoDefinition(),
]);

/**
 * <summary>
 * Exposes the immutable ordered public unit keys used by configuration validation and the Homebridge schema.
 * </summary>
 */
const SUPPORTED_WEATHER_UNITS = Object.freeze(
  DEFAULT_WEATHER_UNIT_DEFINITIONS.map((definition) => definition.unit),
);

module.exports = {
  DEFAULT_WEATHER_UNIT_DEFINITIONS,
  SUPPORTED_WEATHER_UNITS,
  COMPASS_16_DISCRETE_VALUES,
  WMO_WEATHER_CODES,
};
