'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  WeatherUnitRegistry,
  createDefaultWeatherUnitRegistry,
} = require('../lib/units/weather-unit-registry');

const EXPECTED_COMPASS_VALUES = Object.freeze([
  'Unavailable',
  'N',
  'NNO',
  'NO',
  'ONO',
  'O',
  'OZO',
  'ZO',
  'ZZO',
  'Z',
  'ZZW',
  'ZW',
  'WZW',
  'W',
  'WNW',
  'NW',
  'NNW',
]);

/**
 * <summary>
 * Creates deterministic HAP UUID support so production unit definitions can be inspected without loading a real
 * Homebridge process. The readable UUID output also makes failures attributable to the originating unit seed.
 * </summary>
 * @returns {object} Minimal HAP namespace containing a deterministic UUID generator.
 */
function createHapDouble() {
  return {
    uuid: {
      /**
       * <summary>
       * Converts one stable production UUID seed into a deterministic value suitable for unit-test assertions.
       * </summary>
       * @param {string} seed Stable seed supplied by the production registry.
       * @returns {string} Readable deterministic test UUID.
       */
      generate(seed) {
        return `uuid:${seed}`;
      },
    },
  };
}

/**
 * <summary>
 * Returns a source value unchanged for custom registry definitions whose tests focus on metadata validation rather
 * than provider conversion behavior.
 * </summary>
 * @param {unknown} value Raw test source value.
 * @returns {unknown} The unchanged source value.
 */
function preserveValue(value) {
  return value;
}

/**
 * <summary>
 * Deliberately returns a string outside the enclosing discrete value list. This models a faulty converter and proves
 * the registry validates normalized output instead of trusting custom normalization functions blindly.
 * </summary>
 * @returns {string} Unsupported discrete output used by a rejection test.
 */
function returnUnsupportedDiscreteValue() {
  return 'O';
}

/**
 * <summary>
 * Creates a complete numeric unit definition for focused automation-contract validation. Definition and
 * characteristic overrides are merged independently so callers can invalidate exactly one aspect at a time.
 * </summary>
 * @param {object} [overrides] Unit-definition fields that replace the numeric defaults.
 * @param {object} [overrides.characteristicProps] Characteristic properties that replace matching defaults.
 * @returns {object} Mutable numeric unit definition accepted by WeatherUnitRegistry when no invalid override is used.
 */
function createNumericDefinition(overrides = {}) {
  const characteristicOverrides = overrides.characteristicProps || {};
  const definitionOverrides = { ...overrides };
  delete definitionOverrides.characteristicProps;

  return {
    unit: 'test',
    automationKind: 'numeric',
    characteristicUuid: 'uuid:test',
    characteristicProps: {
      format: 'float',
      unit: 'test',
      perms: ['pr', 'ev'],
      minValue: -1,
      maxValue: 100,
      ...characteristicOverrides,
    },
    normalize: preserveValue,
    neutralValue: -1,
    ...definitionOverrides,
  };
}

/**
 * <summary>
 * Creates a complete string-backed discrete definition with a fixed automation value list and explicit unavailable
 * fallback. Callers may override individual fields to exercise registry validation boundaries.
 * </summary>
 * @param {object} [overrides] Unit-definition fields that replace the discrete defaults.
 * @param {object} [overrides.characteristicProps] Characteristic properties that replace matching defaults.
 * @returns {object} Mutable discrete unit definition suitable for WeatherUnitRegistry construction.
 */
function createDiscreteDefinition(overrides = {}) {
  const characteristicOverrides = overrides.characteristicProps || {};
  const definitionOverrides = { ...overrides };
  delete definitionOverrides.characteristicProps;

  return createNumericDefinition({
    automationKind: 'discrete',
    characteristicProps: {
      format: 'string',
      unit: 'test',
      perms: ['pr', 'ev'],
      maxLen: 32,
      ...characteristicOverrides,
    },
    neutralValue: 'Unavailable',
    discreteValues: ['Unavailable', 'N', 'WNW'],
    ...definitionOverrides,
  });
}

/**
 * <summary>
 * Builds the complete provider-neutral WMO automation domain, including the unavailable sentinel followed by every
 * integer weather code from zero through ninety-nine.
 * </summary>
 * @returns {ReadonlyArray<number>} Ordered WMO discrete values expected from production metadata.
 */
function createExpectedWmoValues() {
  const values = [-1];
  for (let code = 0; code <= 99; code += 1) {
    values.push(code);
  }
  return Object.freeze(values);
}

/**
 * <summary>
 * Constructs a registry with an unsupported automation category to verify the public metadata vocabulary remains
 * deliberately limited to numeric, discrete, and informational units.
 * </summary>
 * @returns {void}
 */
function constructUnknownAutomationKindRegistry() {
  new WeatherUnitRegistry([createNumericDefinition({ automationKind: 'unknown' })]);
}

/**
 * <summary>
 * Constructs a registry whose numeric automation category is paired with a textual characteristic format, which
 * would prevent HomeKit clients from applying numeric comparisons.
 * </summary>
 * @returns {void}
 */
function constructNumericStringRegistry() {
  new WeatherUnitRegistry([
    createNumericDefinition({
      neutralValue: 'Unavailable',
      characteristicProps: {
        format: 'string',
        unit: 'test',
        perms: ['pr', 'ev'],
        maxLen: 32,
      },
    }),
  ]);
}

/**
 * <summary>
 * Constructs a discrete registry definition without its required fixed value domain.
 * </summary>
 * @returns {void}
 */
function constructDiscreteRegistryWithoutValues() {
  const definition = createDiscreteDefinition();
  delete definition.discreteValues;
  new WeatherUnitRegistry([definition]);
}

/**
 * <summary>
 * Constructs a discrete registry definition with a repeated value, which would make its automation domain
 * ambiguous and unnecessarily controller-dependent.
 * </summary>
 * @returns {void}
 */
function constructDiscreteRegistryWithDuplicateValues() {
  new WeatherUnitRegistry([
    createDiscreteDefinition({ discreteValues: ['Unavailable', 'N', 'N'] }),
  ]);
}

/**
 * <summary>
 * Constructs a discrete registry definition whose neutral fallback is absent from the advertised automation values.
 * </summary>
 * @returns {void}
 */
function constructDiscreteRegistryWithoutNeutralValue() {
  new WeatherUnitRegistry([
    createDiscreteDefinition({ discreteValues: ['N', 'WNW'] }),
  ]);
}

/**
 * <summary>
 * Constructs a string-backed discrete definition containing a numeric member, proving every fixed value must match
 * the characteristic's JavaScript value type.
 * </summary>
 * @returns {void}
 */
function constructDiscreteRegistryWithWrongValueType() {
  new WeatherUnitRegistry([
    createDiscreteDefinition({ discreteValues: ['Unavailable', 'N', 1] }),
  ]);
}

/**
 * <summary>
 * Constructs a valid discrete registry whose converter returns an unadvertised value, then invokes that converter to
 * verify normalized output is checked against the stored fixed value domain.
 * </summary>
 * @returns {void}
 */
function normalizeValueOutsideDiscreteDomain() {
  const registry = new WeatherUnitRegistry([
    createDiscreteDefinition({ normalize: returnUnsupportedDiscreteValue }),
  ]);
  registry.get('test').normalize('N');
}

/**
 * <summary>
 * Verifies every automatable production unit is paired-readable, event-notifiable, and never writable, while the
 * unbounded ISO timestamp remains informational and therefore deliberately omits event notification metadata.
 * </summary>
 * @returns {void}
 */
function productionUnitsExposeAutomationPermissionsByKind() {
  const registry = createDefaultWeatherUnitRegistry(createHapDouble());
  let numericCount = 0;
  let discreteCount = 0;
  const informationalUnits = [];

  for (const definition of registry.list()) {
    const permissions = definition.characteristicProps.perms;
    assert.equal(permissions.includes('pr'), true, `${definition.unit} must be readable`);
    assert.equal(permissions.includes('pw'), false, `${definition.unit} must remain read-only`);

    if (definition.automationKind === 'numeric') {
      numericCount += 1;
      assert.equal(permissions.includes('ev'), true, `${definition.unit} must emit numeric value changes`);
      continue;
    }

    if (definition.automationKind === 'discrete') {
      discreteCount += 1;
      assert.equal(permissions.includes('ev'), true, `${definition.unit} must emit discrete value changes`);
      continue;
    }

    assert.equal(definition.automationKind, 'informational');
    assert.deepEqual(permissions, ['pr']);
    informationalUnits.push(definition.unit);
  }

  assert.equal(numericCount > 0, true);
  assert.equal(discreteCount > 0, true);
  assert.deepEqual(informationalUnits, ['iso8601']);
}

/**
 * <summary>
 * Verifies production numeric units return plain JavaScript numbers and carry their display unit only in HomeKit
 * characteristic metadata. This preserves number-based automation comparisons without embedding symbols in values.
 * </summary>
 * @returns {void}
 */
function numericUnitsKeepValuesSeparateFromUnitMetadata() {
  const registry = createDefaultWeatherUnitRegistry(createHapDouble());

  for (const definition of registry.list()) {
    if (definition.automationKind !== 'numeric') {
      continue;
    }

    const rawValue = definition.unit === 'compass16->°' ? 'N' : 1;
    const normalizedValue = definition.normalize(rawValue);
    assert.equal(typeof normalizedValue, 'number', `${definition.unit} must normalize to a number`);
    assert.equal(typeof definition.characteristicProps.unit, 'string');
  }
}

/**
 * <summary>
 * Verifies both compass-text unit variants expose the exact closed Dutch sixteen-point direction list plus the
 * unavailable fallback, and that degree conversion produces a listed WNW value suitable for equality automation.
 * </summary>
 * @returns {void}
 */
function compassUnitsExposeExactDiscreteAutomationValues() {
  const registry = createDefaultWeatherUnitRegistry(createHapDouble());
  const directCompass = registry.get('compass16');
  const convertedCompass = registry.get('°->compass16');

  assert.equal(directCompass.automationKind, 'discrete');
  assert.equal(convertedCompass.automationKind, 'discrete');
  assert.deepEqual(directCompass.discreteValues, EXPECTED_COMPASS_VALUES);
  assert.deepEqual(convertedCompass.discreteValues, EXPECTED_COMPASS_VALUES);
  assert.equal(Object.prototype.hasOwnProperty.call(directCompass.characteristicProps, 'validValues'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(convertedCompass.characteristicProps, 'validValues'), false);
  assert.equal(directCompass.normalize('WNW'), 'WNW');
  assert.equal(convertedCompass.normalize(292.5), 'WNW');
}

/**
 * <summary>
 * Verifies WMO remains a numeric fixed-value automation domain from the unavailable sentinel through every two-digit
 * code. The same numeric domain must be present in HAP validValues so compatible clients can select exact values.
 * </summary>
 * @returns {void}
 */
function wmoExposesCompleteNumericDiscreteAutomationValues() {
  const definition = createDefaultWeatherUnitRegistry(createHapDouble()).get('WMO');
  const expectedValues = createExpectedWmoValues();

  assert.equal(definition.automationKind, 'discrete');
  assert.deepEqual(definition.discreteValues, expectedValues);
  assert.deepEqual(definition.characteristicProps.validValues, expectedValues);
  for (const value of definition.discreteValues) {
    assert.equal(typeof value, 'number');
  }
}

/**
 * <summary>
 * Verifies registry construction rejects unsupported automation categories, numeric categories backed by text, and
 * incomplete, ambiguous, or type-incompatible discrete value domains before HomeKit services can be created.
 * </summary>
 * @returns {void}
 */
function registryRejectsInvalidAutomationContracts() {
  assert.throws(constructUnknownAutomationKindRegistry, /automationKind/);
  assert.throws(constructNumericStringRegistry, /numeric.*format/i);
  assert.throws(constructDiscreteRegistryWithoutValues, /discreteValues/);
  assert.throws(constructDiscreteRegistryWithDuplicateValues, /discreteValues.*unique/i);
  assert.throws(constructDiscreteRegistryWithoutNeutralValue, /discreteValues.*neutralValue/i);
  assert.throws(constructDiscreteRegistryWithWrongValueType, /discrete value.*string/i);
}

/**
 * <summary>
 * Verifies the registry owns an immutable copy of a caller-supplied discrete domain and enforces that domain after
 * conversion, preventing later mutation or faulty normalization from exposing undocumented automation values.
 * </summary>
 * @returns {void}
 */
function registryCopiesAndEnforcesDiscreteAutomationValues() {
  const sourceValues = ['Unavailable', 'N', 'WNW'];
  const registry = new WeatherUnitRegistry([
    createDiscreteDefinition({ discreteValues: sourceValues }),
  ]);
  const storedValues = registry.get('test').discreteValues;

  sourceValues.push('O');

  assert.notEqual(storedValues, sourceValues);
  assert.deepEqual(storedValues, ['Unavailable', 'N', 'WNW']);
  assert.equal(Object.isFrozen(storedValues), true);
  assert.throws(normalizeValueOutsideDiscreteDomain, /not a supported discrete value/i);
}

/**
 * <summary>
 * Creates a numeric fixed-value definition whose internal discrete domain and HAP validValues metadata describe the
 * same exact values. Callers can override definition or characteristic fields to isolate audit regression cases.
 * </summary>
 * @param {object} [overrides] Unit-definition fields that replace the numeric-discrete defaults.
 * @param {object} [overrides.characteristicProps] Characteristic properties that replace matching defaults.
 * @returns {object} Mutable numeric-discrete unit definition suitable for registry contract tests.
 */
function createNumericDiscreteDefinition(overrides = {}) {
  const characteristicOverrides = overrides.characteristicProps || {};
  const definitionOverrides = { ...overrides };
  delete definitionOverrides.characteristicProps;

  return createNumericDefinition({
    automationKind: 'discrete',
    characteristicProps: {
      format: 'int',
      unit: 'test',
      perms: ['pr', 'ev'],
      minValue: -1,
      maxValue: 1,
      validValues: [-1, 0, 1],
      ...characteristicOverrides,
    },
    neutralValue: -1,
    discreteValues: [-1, 0, 1],
    ...definitionOverrides,
  });
}

/**
 * <summary>
 * Constructs a numeric registry definition that contains the required read and event permissions plus an unsupported
 * additional permission. Exact policy validation must reject this otherwise read-only-looking superset.
 * </summary>
 * @returns {void}
 */
function constructNumericRegistryWithExtraPermission() {
  new WeatherUnitRegistry([
    createNumericDefinition({
      characteristicProps: { perms: ['pr', 'ev', 'aa'] },
    }),
  ]);
}

/**
 * <summary>
 * Constructs an informational string definition that contains paired-read permission plus an unsupported additional
 * permission. Informational units must expose exactly the plugin-owned read-only policy.
 * </summary>
 * @returns {void}
 */
function constructInformationalRegistryWithExtraPermission() {
  new WeatherUnitRegistry([
    createNumericDefinition({
      automationKind: 'informational',
      characteristicProps: {
        format: 'string',
        unit: 'test',
        perms: ['pr', 'aa'],
        maxLen: 32,
      },
      neutralValue: 'Unavailable',
    }),
  ]);
}

/**
 * <summary>
 * Constructs a numeric fixed-value definition without HAP validValues. Numeric discrete domains must be advertised
 * to compatible HomeKit clients as well as retained internally, so the incomplete definition must be rejected.
 * </summary>
 * @returns {void}
 */
function constructNumericDiscreteRegistryWithoutHapValidValues() {
  const definition = createNumericDiscreteDefinition();
  delete definition.characteristicProps.validValues;
  new WeatherUnitRegistry([definition]);
}

/**
 * <summary>
 * Verifies registry extensions use the exact permission set owned by each automation kind rather than accepting
 * arbitrary supersets. Equivalent required permissions remain valid when supplied in a different order.
 * </summary>
 * @returns {void}
 */
function registryRequiresExactPermissionPolicySets() {
  assert.throws(constructNumericRegistryWithExtraPermission, TypeError);
  assert.throws(constructInformationalRegistryWithExtraPermission, TypeError);

  const reorderedRegistry = new WeatherUnitRegistry([
    createNumericDefinition({
      characteristicProps: { perms: ['ev', 'pr'] },
    }),
  ]);
  assert.deepEqual(reorderedRegistry.get('test').characteristicProps.perms, ['ev', 'pr']);
}

/**
 * <summary>
 * Verifies every numeric discrete domain has matching HAP validValues metadata and that a complete exact match remains
 * accepted. This prevents fixed numeric values from silently losing exact-value automation metadata in HomeKit.
 * </summary>
 * @returns {void}
 */
function numericDiscreteRequiresMatchingHapValidValues() {
  assert.throws(constructNumericDiscreteRegistryWithoutHapValidValues, TypeError);

  const registry = new WeatherUnitRegistry([createNumericDiscreteDefinition()]);
  const storedDefinition = registry.get('test');
  assert.deepEqual(storedDefinition.discreteValues, [-1, 0, 1]);
  assert.deepEqual(storedDefinition.characteristicProps.validValues, [-1, 0, 1]);
}
test('production units expose read-only automation permissions by automation kind', productionUnitsExposeAutomationPermissionsByKind);
test('numeric units keep numbers separate from unit metadata', numericUnitsKeepValuesSeparateFromUnitMetadata);
test('compass units expose the exact fixed automation value list', compassUnitsExposeExactDiscreteAutomationValues);
test('WMO exposes the complete numeric discrete automation domain', wmoExposesCompleteNumericDiscreteAutomationValues);
test('weather unit registry rejects invalid automation contracts', registryRejectsInvalidAutomationContracts);
test('weather unit registry requires exact permission policy sets', registryRequiresExactPermissionPolicySets);
test('numeric discrete units require matching HAP validValues', numericDiscreteRequiresMatchingHapValidValues);
test('weather unit registry copies and enforces discrete automation values', registryCopiesAndEnforcesDiscreteAutomationValues);
