'use strict';

const { PLUGIN_NAME } = require('../constants');
const { DEFAULT_WEATHER_UNIT_DEFINITIONS } = require('./weather-unit-definitions');
const {
  WEATHER_UNIT_AUTOMATION_KINDS,
  isWeatherUnitAutomationKind,
  getWeatherUnitAutomationPermissions,
} = require('./weather-unit-automation');

const NUMERIC_FORMATS = new Set(['float', 'int', 'uint8', 'uint16', 'uint32', 'uint64']);
const INTEGER_FORMATS = new Set(['int', 'uint8', 'uint16', 'uint32', 'uint64']);
const UNSIGNED_FORMATS = new Set(['uint8', 'uint16', 'uint32', 'uint64']);
const SUPPORTED_FORMATS = new Set([...NUMERIC_FORMATS, 'bool', 'string']);

/**
 * <summary>
 * Stores the plugin-owned catalog of unit definitions. Each definition controls representation, validation,
 * neutral fallback, and automation semantics; the mapping supplies only the visible measurement name and path.
 * The same unit may therefore be reused by any number of differently named mappings on the single accessory.
 * </summary>
 */
class WeatherUnitRegistry {
  /**
   * <summary>
   * Creates an immutable lookup from explicit unit definitions and validates the complete extension contract.
   * Definitions, HomeKit metadata, permission lists, and fixed value sets are independently copied and frozen so
   * callers cannot change runtime behavior after registration. Every normalizer is wrapped with format, range, and
   * discrete-domain validation before it is exposed to the service manager.
   * </summary>
   * @param {ReadonlyArray<object>} definitions Complete custom-characteristic definitions keyed by compact unit.
   * @throws {TypeError} When a definition is incomplete, inconsistent, or uses a duplicate unit.
   */
  constructor(definitions) {
    if (!Array.isArray(definitions)) {
      throw new TypeError('Weather unit definitions must be an array');
    }

    this.definitions = new Map();

    for (const definition of definitions) {
      validateDefinition(definition);

      if (this.definitions.has(definition.unit)) {
        throw new TypeError(`Duplicate weather unit definition: ${definition.unit}`);
      }

      const copiedDefinition = {
        ...definition,
        characteristicProps: copyCharacteristicProps(definition.characteristicProps),
      };

      if (Array.isArray(definition.discreteValues)) {
        copiedDefinition.discreteValues = Object.freeze(Array.from(definition.discreteValues));
      }

      const primitiveNormalizer = definition.normalize;
      copiedDefinition.normalize = createValidatedNormalizer(copiedDefinition, primitiveNormalizer);

      const storedDefinition = Object.freeze(copiedDefinition);
      this.definitions.set(storedDefinition.unit, storedDefinition);
    }
  }

  /**
   * <summary>
   * Determines whether a compact configuration unit is supported exactly as written. Lookup is case-sensitive
   * because scientific symbols such as `m`, `mm`, and `MJ/m²` have distinct meanings.
   * </summary>
   * @param {string} unit Compact configured unit symbol.
   * @returns {boolean} True when the plugin owns a matching unit definition.
   */
  has(unit) {
    return this.definitions.has(unit);
  }

  /**
   * <summary>
   * Retrieves the immutable definition for one normalized configuration unit, including its internal automation
   * classification and any fixed output domain.
   * </summary>
   * @param {string} unit Compact configured unit symbol.
   * @returns {object|undefined} Matching definition or undefined for an unsupported unit.
   */
  get(unit) {
    return this.definitions.get(unit);
  }

  /**
   * <summary>
   * Returns the supported unit catalog in stable schema order without exposing the registry's mutable lookup map.
   * </summary>
   * @returns {ReadonlyArray<object>} Frozen snapshot of immutable unit definitions.
   */
  list() {
    return Object.freeze(Array.from(this.definitions.values()));
  }
}

/**
 * <summary>
 * Validates one resolved unit definition after its characteristic UUID and HAP property object have been assigned.
 * The unit's neutral value, permission policy, output format, and optional fixed value domain must describe one
 * coherent read-only characteristic before Homebridge can expose it.
 * </summary>
 * @param {object} definition Candidate resolved unit definition.
 * @returns {void}
 * @throws {TypeError} When any required unit, characteristic, normalization, fallback, or automation field is invalid.
 */
function validateDefinition(definition) {
  if (!definition || typeof definition !== 'object') {
    throw new TypeError('Weather unit definitions must be objects');
  }

  if (typeof definition.unit !== 'string' || definition.unit.trim() === '') {
    throw new TypeError('Weather unit definitions require a non-empty unit');
  }

  if (typeof definition.characteristicUuid !== 'string' || definition.characteristicUuid.trim() === '') {
    throw new TypeError(`Weather unit ${definition.unit} requires a characteristicUuid`);
  }

  if (!definition.characteristicProps || typeof definition.characteristicProps !== 'object') {
    throw new TypeError(`Weather unit ${definition.unit} requires characteristicProps`);
  }

  const { format, perms } = definition.characteristicProps;
  if (typeof format !== 'string' || !SUPPORTED_FORMATS.has(format)) {
    throw new TypeError(`Weather unit ${definition.unit} uses an unsupported characteristic format`);
  }
  if (!Array.isArray(perms) || !perms.includes('pr')) {
    throw new TypeError(`Weather unit ${definition.unit} characteristicProps require paired-read permission`);
  }

  if (typeof definition.normalize !== 'function') {
    throw new TypeError(`Weather unit ${definition.unit} requires a normalize function`);
  }

  if (!Object.prototype.hasOwnProperty.call(definition, 'neutralValue')) {
    throw new TypeError(`Weather unit ${definition.unit} requires a neutralValue`);
  }

  validateCharacteristicValue(
    definition.neutralValue,
    definition.characteristicProps,
    `Weather unit ${definition.unit} neutralValue`,
  );
  validateAutomationContract(definition);
}

/**
 * <summary>
 * Validates the internal automation classification against HAP format and the exact plugin-owned permission set.
 * Permission order is irrelevant, but missing, additional, or duplicated permissions are rejected; consequently
 * every registered weather characteristic remains read-only and only numeric or discrete output publishes events.
 * Fixed-set units additionally receive complete domain validation, independent of their JavaScript value type.
 * </summary>
 * @param {object} definition Candidate resolved unit definition with validated basic characteristic metadata.
 * @returns {void}
 * @throws {TypeError} When automation metadata, permissions, or a fixed output domain is inconsistent.
 */
function validateAutomationContract(definition) {
  const { automationKind, characteristicProps, discreteValues, neutralValue, unit } = definition;
  const { format, perms } = characteristicProps;

  if (!isWeatherUnitAutomationKind(automationKind)) {
    throw new TypeError(`Weather unit ${unit} requires a supported automationKind`);
  }

  const expectedPermissions = getWeatherUnitAutomationPermissions(automationKind);
  const actualPermissionSet = new Set(perms);
  let containsEveryExpectedPermission = true;

  for (const expectedPermission of expectedPermissions) {
    if (!actualPermissionSet.has(expectedPermission)) {
      containsEveryExpectedPermission = false;
      break;
    }
  }

  if (perms.includes('pw')) {
    throw new TypeError(`Weather unit ${unit} must remain read-only`);
  }
  if (
    actualPermissionSet.size !== perms.length ||
    perms.length !== expectedPermissions.length ||
    !containsEveryExpectedPermission
  ) {
    throw new TypeError(
      `Weather unit ${unit} permissions must exactly match automationKind ${automationKind}`,
    );
  }

  if (automationKind === WEATHER_UNIT_AUTOMATION_KINDS.NUMERIC && !NUMERIC_FORMATS.has(format)) {
    throw new TypeError(`Weather unit ${unit} numeric automation requires a numeric characteristic format`);
  }

  if (automationKind === WEATHER_UNIT_AUTOMATION_KINDS.DISCRETE) {
    validateDiscreteValues(discreteValues, neutralValue, characteristicProps, unit);
    return;
  }

  if (Array.isArray(discreteValues)) {
    throw new TypeError(`Weather unit ${unit} exposes discreteValues without discrete automation`);
  }
  if (Array.isArray(characteristicProps.validValues)) {
    throw new TypeError(`Weather unit ${unit} exposes HAP validValues without discrete automation`);
  }
}

/**
 * <summary>
 * Validates a fixed output domain for exact-value automation. Values must be unique, include the unit's neutral
 * fallback, and satisfy the same format and range constraints as runtime output. Numeric formats must expose HAP
 * validValues in the exact same order as the internal domain. String and boolean domains remain internal-only
 * because HAP validValues cannot describe their semantic labels.
 * </summary>
 * @param {unknown} discreteValues Candidate fixed output domain.
 * @param {unknown} neutralValue Unit-specific unavailable value that must belong to the domain.
 * @param {object} props HAP characteristic properties governing every fixed value.
 * @param {string} unit Compact unit identifier used in validation messages.
 * @returns {void}
 * @throws {TypeError} When the domain is empty, duplicated, incomplete, mistyped, out of range, or mismatched.
 */
function validateDiscreteValues(discreteValues, neutralValue, props, unit) {
  if (!Array.isArray(discreteValues) || discreteValues.length === 0) {
    throw new TypeError(`Weather unit ${unit} discrete automation requires a non-empty discreteValues array`);
  }
  if (new Set(discreteValues).size !== discreteValues.length) {
    throw new TypeError(`Weather unit ${unit} discreteValues must be unique`);
  }
  if (!discreteValues.includes(neutralValue)) {
    throw new TypeError(`Weather unit ${unit} discreteValues must include neutralValue`);
  }

  for (const value of discreteValues) {
    validateCharacteristicValue(value, props, `Weather unit ${unit} discrete value`);
  }

  if (NUMERIC_FORMATS.has(props.format)) {
    if (!Array.isArray(props.validValues)) {
      throw new TypeError(
        `Weather unit ${unit} numeric discrete automation requires HAP validValues`,
      );
    }

    let validValuesMatch = props.validValues.length === discreteValues.length;
    if (validValuesMatch) {
      for (let index = 0; index < discreteValues.length; index += 1) {
        if (props.validValues[index] !== discreteValues[index]) {
          validValuesMatch = false;
          break;
        }
      }
    }

    if (!validValuesMatch) {
      throw new TypeError(`Weather unit ${unit} HAP validValues must match discreteValues in order`);
    }
    return;
  }

  if (Array.isArray(props.validValues)) {
    throw new TypeError(
      `Weather unit ${unit} non-numeric discreteValues cannot be advertised as HAP validValues`,
    );
  }
}

/**
 * <summary>
 * Copies and deeply freezes the array-valued portions of characteristic metadata. This prevents external definition
 * objects from mutating permissions or numeric HAP value constraints after the registry has accepted them.
 * </summary>
 * @param {object} props Validated HAP characteristic properties.
 * @returns {Readonly<object>} Independent frozen characteristic-property snapshot.
 */
function copyCharacteristicProps(props) {
  const copy = { ...props };
  if (Array.isArray(props.perms)) {
    copy.perms = Object.freeze(Array.from(props.perms));
  }
  if (Array.isArray(props.validValues)) {
    copy.validValues = Object.freeze(Array.from(props.validValues));
  }
  if (Array.isArray(props.validValueRanges)) {
    copy.validValueRanges = Object.freeze(Array.from(props.validValueRanges));
  }
  return Object.freeze(copy);
}

/**
 * <summary>
 * Validates a characteristic value against HAP format, signedness, range, text length, and optional numeric
 * validValues metadata. It is shared by registry fallback validation, fixed-domain validation, and source output.
 * </summary>
 * @param {unknown} value Candidate normalized, neutral, or discrete characteristic value.
 * @param {object} props HAP characteristic properties defining accepted values.
 * @param {string} label Context included in programming-error messages.
 * @returns {void}
 * @throws {TypeError} When the candidate is incompatible with the characteristic properties.
 */
function validateCharacteristicValue(value, props, label) {
  if (NUMERIC_FORMATS.has(props.format)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`${label} must be a finite number`);
    }
    if (INTEGER_FORMATS.has(props.format) && !Number.isInteger(value)) {
      throw new TypeError(`${label} must be an integer`);
    }
    if (UNSIGNED_FORMATS.has(props.format) && value < 0) {
      throw new TypeError(`${label} must not be negative`);
    }
    if (Number.isFinite(props.minValue) && value < props.minValue) {
      throw new TypeError(`${label} is below the supported range`);
    }
    if (Number.isFinite(props.maxValue) && value > props.maxValue) {
      throw new TypeError(`${label} is above the supported range`);
    }
    if (Array.isArray(props.validValues) && !props.validValues.includes(value)) {
      throw new TypeError(`${label} is not a supported discrete value`);
    }
    if (
      Array.isArray(props.validValueRanges) &&
      props.validValueRanges.length === 2 &&
      (value < props.validValueRanges[0] || value > props.validValueRanges[1])
    ) {
      throw new TypeError(`${label} is outside the supported value range`);
    }
    return;
  }

  if (props.format === 'bool') {
    if (typeof value !== 'boolean') {
      throw new TypeError(`${label} must be a boolean`);
    }
    return;
  }

  if (props.format === 'string') {
    if (typeof value !== 'string') {
      throw new TypeError(`${label} must be a string`);
    }
    if (Number.isInteger(props.maxLen) && value.length > props.maxLen) {
      throw new TypeError(`${label} exceeds the supported text length`);
    }
  }
}

/**
 * <summary>
 * Creates the production unit registry from the compact catalog and the HAP UUID generator supplied by Homebridge.
 * Every unit receives a stable plugin-owned characteristic UUID derived only from the plugin name and unit symbol.
 * Automation metadata is copied from the unit definition and cannot be overridden by mapping configuration.
 * </summary>
 * @param {object} hap Homebridge HAP namespace containing a deterministic uuid.generate function.
 * @returns {WeatherUnitRegistry} Complete production unit registry.
 * @throws {TypeError} When Homebridge does not supply the required HAP UUID generator.
 */
function createDefaultWeatherUnitRegistry(hap) {
  if (!hap || !hap.uuid || typeof hap.uuid.generate !== 'function') {
    throw new TypeError('The default weather unit registry requires Homebridge HAP UUID support');
  }

  const definitions = DEFAULT_WEATHER_UNIT_DEFINITIONS.map((definition) => ({
    unit: definition.unit,
    automationKind: definition.automationKind,
    ...(Array.isArray(definition.discreteValues)
      ? { discreteValues: definition.discreteValues }
      : {}),
    characteristicUuid: hap.uuid.generate(`${PLUGIN_NAME}:weather-unit:${definition.unit}`),
    characteristicProps: createCharacteristicProps(definition),
    normalize: definition.normalize,
    neutralValue: definition.neutralValue,
  }));

  return new WeatherUnitRegistry(definitions);
}

/**
 * <summary>
 * Converts one provider-independent unit definition into read-only HAP characteristic properties. Numeric and
 * fixed-set output receives read/event permissions, informational output receives read permission only, and numeric
 * fixed domains are additionally advertised through HAP validValues. String domains remain internal because HAP
 * validValues supports numeric entries only.
 * </summary>
 * @param {object} definition Immutable compact unit definition.
 * @returns {Readonly<object>} Characteristic properties accepted by the HAP Characteristic constructor.
 */
function createCharacteristicProps(definition) {
  const props = {
    format: definition.format,
    unit: definition.homeKitUnit,
    perms: getWeatherUnitAutomationPermissions(definition.automationKind),
  };

  if (Number.isFinite(definition.minValue)) {
    props.minValue = definition.minValue;
  }
  if (Number.isFinite(definition.maxValue)) {
    props.maxValue = definition.maxValue;
  }
  if (Number.isFinite(definition.minStep)) {
    props.minStep = definition.minStep;
  }
  if (Number.isInteger(definition.maxLength)) {
    props.maxLen = definition.maxLength;
  }
  if (
    definition.automationKind === WEATHER_UNIT_AUTOMATION_KINDS.DISCRETE &&
    NUMERIC_FORMATS.has(definition.format) &&
    Array.isArray(definition.discreteValues)
  ) {
    props.validValues = definition.discreteValues;
  }

  return Object.freeze(props);
}

/**
 * <summary>
 * Wraps a unit's primitive conversion with characteristic constraints and fixed-domain membership. Invalid provider
 * values throw before reaching HAP, allowing the service manager to publish the unit's explicit neutral fallback.
 * The wrapper preserves raw numeric values and canonical fixed-set strings without appending display units.
 * </summary>
 * @param {object} definition Immutable resolved unit definition with copied characteristic metadata.
 * @param {Function} primitiveNormalizer Unit-specific primitive converter supplied by the definition.
 * @returns {Function} Unit-specific normalization and validation function.
 */
function createValidatedNormalizer(definition, primitiveNormalizer) {
  /**
   * <summary>
   * Converts and validates one raw source value against the enclosing unit's format, bounds, and automation domain.
   * </summary>
   * @param {unknown} value Raw value resolved from the configured source path.
   * @returns {number|string|boolean} Valid normalized characteristic value.
   * @throws {TypeError} When the value violates characteristic or fixed-domain constraints.
   */
  function normalizeAndValidate(value) {
    const normalized = primitiveNormalizer(value);
    validateCharacteristicValue(
      normalized,
      definition.characteristicProps,
      `Weather unit ${definition.unit} value`,
    );

    if (
      definition.automationKind === WEATHER_UNIT_AUTOMATION_KINDS.DISCRETE &&
      !definition.discreteValues.includes(normalized)
    ) {
      throw new TypeError(`Weather unit ${definition.unit} value is not a supported discrete value`);
    }

    return normalized;
  }

  return normalizeAndValidate;
}

module.exports = {
  WeatherUnitRegistry,
  createDefaultWeatherUnitRegistry,
};
