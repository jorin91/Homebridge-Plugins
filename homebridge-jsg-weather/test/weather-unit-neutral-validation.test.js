'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { WeatherUnitRegistry } = require('../lib/units/weather-unit-registry');

/**
 * <summary>
 * Returns one source value unchanged so registry tests can focus exclusively on definition validation.
 * </summary>
 * @param {unknown} value Raw source value.
 * @returns {unknown} Unchanged source value.
 */
function preserveValue(value) {
  return value;
}

/**
 * <summary>
 * Creates a complete mutable unit definition whose characteristic properties can be overridden for one focused
 * validation scenario.
 * </summary>
 * @param {object} [overrides] Definition fields that replace the numeric defaults.
 * @returns {object} Complete unit definition suitable for WeatherUnitRegistry construction.
 */
function createDefinition(overrides = {}) {
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
      ...overrides.characteristicProps,
    },
    normalize: preserveValue,
    neutralValue: -1,
    ...overrides,
  };
}

/**
 * <summary>
 * Verifies a valid neutral fallback is accepted and that mutable nested HAP metadata is copied and frozen rather
 * than retained by reference.
 * </summary>
 * @returns {void}
 */
function acceptsValidNeutralAndFreezesMetadata() {
  const permissions = ['pr', 'ev'];
  const validValues = [-1, 0, 1];
  const definition = createDefinition({
    automationKind: 'discrete',
    discreteValues: validValues,
    characteristicProps: {
      format: 'int',
      unit: 'test',
      perms: permissions,
      minValue: -1,
      maxValue: 1,
      validValues,
    },
  });
  const registry = new WeatherUnitRegistry([definition]);
  const storedProps = registry.get('test').characteristicProps;

  permissions.push('pw');
  validValues.push(2);

  assert.deepEqual(storedProps.perms, ['pr', 'ev']);
  assert.deepEqual(storedProps.validValues, [-1, 0, 1]);
  assert.equal(Object.isFrozen(storedProps), true);
  assert.equal(Object.isFrozen(storedProps.perms), true);
  assert.equal(Object.isFrozen(storedProps.validValues), true);
}

/**
 * <summary>
 * Verifies a numeric characteristic rejects a neutral fallback with the wrong JavaScript value type.
 * </summary>
 * @returns {void}
 */
function rejectsWrongNumericNeutralType() {
  /**
   * <summary>
   * Constructs a registry whose floating-point neutral fallback is invalid text.
   * </summary>
   * @returns {void}
   */
  function constructInvalidRegistry() {
    new WeatherUnitRegistry([createDefinition({ neutralValue: 'Unavailable' })]);
  }

  assert.throws(constructInvalidRegistry, /neutralValue must be a finite number/);
}

/**
 * <summary>
 * Verifies numeric neutral fallbacks must obey advertised minimum, maximum, and explicit discrete-value metadata.
 * </summary>
 * @returns {void}
 */
function rejectsNumericNeutralOutsideCharacteristicConstraints() {
  /**
   * <summary>
   * Constructs a registry whose neutral fallback is below the advertised numeric minimum.
   * </summary>
   * @returns {void}
   */
  function constructBelowMinimumRegistry() {
    new WeatherUnitRegistry([
      createDefinition({
        neutralValue: -2,
        characteristicProps: {
          format: 'float',
          unit: 'test',
          perms: ['pr', 'ev'],
          minValue: -1,
          maxValue: 100,
        },
      }),
    ]);
  }

  /**
   * <summary>
   * Constructs a registry whose integer neutral fallback is absent from the advertised discrete values.
   * </summary>
   * @returns {void}
   */
  function constructUnsupportedDiscreteRegistry() {
    new WeatherUnitRegistry([
      createDefinition({
        automationKind: 'discrete',
        discreteValues: [0, 1, 2],
        neutralValue: -1,
        characteristicProps: {
          format: 'int',
          unit: 'test',
          perms: ['pr', 'ev'],
          minValue: -1,
          maxValue: 99,
          validValues: [0, 1, 2],
        },
      }),
    ]);
  }

  assert.throws(constructBelowMinimumRegistry, /below the supported range/);
  assert.throws(constructUnsupportedDiscreteRegistry, /not a supported discrete value/);
}

/**
 * <summary>
 * Verifies textual neutral fallbacks cannot exceed the maximum length advertised to HomeKit clients.
 * </summary>
 * @returns {void}
 */
function rejectsTextNeutralAboveMaximumLength() {
  /**
   * <summary>
   * Constructs a registry whose text fallback is longer than the characteristic permits.
   * </summary>
   * @returns {void}
   */
  function constructInvalidRegistry() {
    new WeatherUnitRegistry([
      createDefinition({
        automationKind: 'informational',
        neutralValue: 'Unavailable',
        characteristicProps: {
          format: 'string',
          unit: 'test',
          perms: ['pr'],
          maxLen: 4,
        },
      }),
    ]);
  }

  assert.throws(constructInvalidRegistry, /exceeds the supported text length/);
}

test('weather unit registry accepts valid neutral values and freezes nested metadata', acceptsValidNeutralAndFreezesMetadata);
test('weather unit registry rejects a numeric neutral value with the wrong type', rejectsWrongNumericNeutralType);
test('weather unit registry rejects neutral values outside numeric constraints', rejectsNumericNeutralOutsideCharacteristicConstraints);
test('weather unit registry rejects text neutral values above the maximum length', rejectsTextNeutralAboveMaximumLength);
