'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  WeatherValueServiceManager,
  createServiceSubtype,
  MANAGED_SUBTYPES_CONTEXT_KEY,
} = require('../lib/homekit/weather-value-service-manager');
const { createMappingKey } = require('../lib/mappings/mapping-identity');
const { WeatherUnitRegistry } = require('../lib/units/weather-unit-registry');

/**
 * <summary>
 * Records cached reads, characteristic metadata, and every published value for one fake custom characteristic.
 * </summary>
 */
class CharacteristicDouble {
  /**
   * <summary>
   * Creates a generic HAP-compatible characteristic with the display metadata supplied by the production factory.
   * </summary>
   * @param {string} displayName User-visible measurement name.
   * @param {string} UUID Stable unit-specific characteristic UUID.
   * @param {object} props Unit-specific HAP properties.
   */
  constructor(displayName, UUID, props) {
    this.displayName = displayName;
    this.UUID = UUID;
    this.props = { ...props };
    this.values = [];
    this.getHandler = undefined;
    this.removeOnGetCount = 0;
  }

  /**
   * <summary>
   * Replaces characteristic presentation metadata during cached-service reconciliation.
   * </summary>
   * @param {object} props Refreshed HAP characteristic properties.
   * @returns {CharacteristicDouble} This characteristic for API-compatible chaining.
   * @sideEffect Replaces the stored property snapshot.
   */
  setProps(props) {
    this.props = { ...props };
    return this;
  }

  /**
   * <summary>
   * Stores the modern cached read callback supplied by the service manager.
   * </summary>
   * @param {Function} handler Callback returning the current cached value.
   * @returns {CharacteristicDouble} This characteristic for API-compatible chaining.
   * @sideEffect Replaces the active get callback.
   */
  onGet(handler) {
    this.getHandler = handler;
    return this;
  }

  /**
   * <summary>
   * Removes the active cached read callback during manager disposal or reconciliation.
   * </summary>
   * @returns {CharacteristicDouble} This characteristic for API-compatible chaining.
   * @sideEffect Clears the callback and increments the removal counter.
   */
  removeOnGet() {
    this.getHandler = undefined;
    this.removeOnGetCount += 1;
    return this;
  }

  /**
   * <summary>
   * Records one normalized or neutral value published by the service manager.
   * </summary>
   * @param {unknown} value Published HomeKit value.
   * @returns {CharacteristicDouble} This characteristic for API-compatible chaining.
   * @sideEffect Appends the value to the publication history.
   */
  updateValue(value) {
    this.values.push(value);
    return this;
  }
}

/**
 * <summary>
 * Represents the generic base HAP Service constructor used by the production custom-service factory.
 * </summary>
 */
class ServiceDouble {
  /**
   * <summary>
   * Creates a custom service with one stable UUID, mapping-specific subtype, and initially no characteristics.
   * </summary>
   * @param {string} displayName User-visible mapping name.
   * @param {string} UUID Plugin-owned custom service UUID.
   * @param {string} subtype Stable mapping-specific service subtype.
   */
  constructor(displayName, UUID, subtype) {
    this.displayName = displayName;
    this.UUID = UUID;
    this.subtype = subtype;
    this.characteristics = [];
  }

  /**
   * <summary>
   * Attaches one custom characteristic to this service.
   * </summary>
   * @param {CharacteristicDouble} characteristic Custom characteristic created by the production factory.
   * @returns {ServiceDouble} This service for API-compatible chaining.
   * @sideEffect Appends the characteristic to the service collection.
   */
  addCharacteristic(characteristic) {
    this.characteristics.push(characteristic);
    return this;
  }
}

/**
 * <summary>
 * Records service attachment and removal for one fake Homebridge platform accessory.
 * </summary>
 */
class AccessoryDouble {
  /**
   * <summary>
   * Creates an accessory with empty non-secret context and no attached services.
   * </summary>
   */
  constructor() {
    this.context = {};
    this.services = [];
  }

  /**
   * <summary>
   * Attaches one service to the accessory.
   * </summary>
   * @param {ServiceDouble} service Service to attach.
   * @returns {void}
   * @sideEffect Appends the service to the accessory collection.
   */
  addService(service) {
    this.services.push(service);
  }

  /**
   * <summary>
   * Removes one exact service instance from the accessory.
   * </summary>
   * @param {ServiceDouble} service Service instance to remove.
   * @returns {void}
   * @sideEffect Replaces the service collection without the supplied instance.
   */
  removeService(service) {
    this.services = this.services.filter(
      /**
       * <summary>
       * Retains services other than the exact removal target.
       * </summary>
       * @param {ServiceDouble} candidate Attached service candidate.
       * @returns {boolean} True when the candidate must remain attached.
       */
      function retainOtherServices(candidate) {
        return candidate !== service;
      },
    );
  }
}

/**
 * <summary>
 * Converts a source value to a finite number for the reusable Celsius test unit.
 * </summary>
 * @param {unknown} value Raw source value.
 * @returns {number} Finite numeric value.
 * @throws {TypeError} When the value is not finite.
 */
function normalizeNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError('Expected a finite number');
  }
  return number;
}

/**
 * <summary>
 * Creates the HAP namespace consumed by generic custom service and characteristic production factories.
 * </summary>
 * @returns {object} HAP double with base constructors and deterministic UUID support.
 */
function createHapDouble() {
  return {
    Service: ServiceDouble,
    Characteristic: CharacteristicDouble,
    uuid: {
      /**
       * <summary>
       * Generates one readable deterministic UUID from a plugin-owned seed.
       * </summary>
       * @param {string} seed Stable plugin UUID seed.
       * @returns {string} Deterministic test UUID.
       */
      generate(seed) {
        return `uuid:${seed}`;
      },
    },
  };
}

/**
 * <summary>
 * Creates a registry containing one reusable Celsius definition shared by differently named mappings.
 * </summary>
 * @returns {WeatherUnitRegistry} Test unit registry with explicit characteristic metadata and neutral value.
 */
function createUnitRegistry() {
  return new WeatherUnitRegistry([
    {
      unit: '°C',
      automationKind: 'numeric',
      characteristicUuid: 'uuid:test:celsius',
      characteristicProps: {
        format: 'float',
        unit: 'celsius',
        perms: ['pr', 'ev'],
        minValue: -273.15,
        maxValue: 1000,
        minStep: 0.01,
      },
      normalize: normalizeNumber,
      neutralValue: -273.15,
    },
  ]);
}

/**
 * <summary>
 * Creates one normalized mapping shape with its hidden deterministic key for service-manager tests.
 * </summary>
 * @param {string} name User-visible measurement name.
 * @param {string} path Source path excluded from mapping identity.
 * @returns {{key: string, name: string, unit: string, path: string}} Normalized Celsius mapping.
 */
function createMapping(name, path) {
  return {
    key: createMappingKey(name, '°C'),
    name,
    unit: '°C',
    path,
  };
}

/**
 * <summary>
 * Retrieves one attached service by subtype without relying on array callback behavior.
 * </summary>
 * @param {AccessoryDouble} accessory Accessory whose services are inspected.
 * @param {string} subtype Required service subtype.
 * @returns {ServiceDouble|undefined} Matching service or undefined.
 */
function getServiceBySubtype(accessory, subtype) {
  for (const service of accessory.services) {
    if (service.subtype === subtype) {
      return service;
    }
  }
  return undefined;
}

/**
 * <summary>
 * Verifies repeated units create separate services and subtypes, initialize independently, and publish only to the
 * mapping selected by its hidden key while remaining grouped under the plugin's single accessory.
 * </summary>
 * @returns {void}
 */
function sameUnitMappingsPublishIndependently() {
  const accessory = new AccessoryDouble();
  const manager = new WeatherValueServiceManager(
    accessory,
    createHapDouble(),
    createUnitRegistry(),
    {},
  );
  const temperature = createMapping('Temperature', '/current/temperature_2m');
  const dewPoint = createMapping('Dew point', '/current/dew_point_2m');

  manager.reconcile([temperature, dewPoint]);

  const temperatureSubtype = createServiceSubtype(temperature.key);
  const dewPointSubtype = createServiceSubtype(dewPoint.key);
  const temperatureService = getServiceBySubtype(accessory, temperatureSubtype);
  const dewPointService = getServiceBySubtype(accessory, dewPointSubtype);
  const temperatureCharacteristic = temperatureService.characteristics[0];
  const dewPointCharacteristic = dewPointService.characteristics[0];

  assert.equal(accessory.services.length, 2);
  assert.notEqual(temperatureSubtype, dewPointSubtype);
  assert.notEqual(temperatureService, dewPointService);
  assert.equal(temperatureService.UUID, dewPointService.UUID);
  assert.deepEqual(accessory.context[MANAGED_SUBTYPES_CONTEXT_KEY], [
    temperatureSubtype,
    dewPointSubtype,
  ]);
  assert.equal(temperatureService.displayName, 'Temperature');
  assert.equal(dewPointService.displayName, 'Dew point');
  assert.equal(temperatureCharacteristic.props.description, 'Temperature (°C)');
  assert.equal(dewPointCharacteristic.props.description, 'Dew point (°C)');
  assert.deepEqual(temperatureCharacteristic.values, [-273.15]);
  assert.deepEqual(dewPointCharacteristic.values, [-273.15]);

  manager.publish(temperature.key, 18.5);
  assert.deepEqual(temperatureCharacteristic.values, [-273.15, 18.5]);
  assert.deepEqual(dewPointCharacteristic.values, [-273.15]);
  assert.equal(temperatureCharacteristic.getHandler(), 18.5);
  assert.equal(dewPointCharacteristic.getHandler(), -273.15);

  manager.publish(dewPoint.key, 11.25);
  assert.equal(temperatureCharacteristic.getHandler(), 18.5);
  assert.equal(dewPointCharacteristic.getHandler(), 11.25);
}

/**
 * <summary>
 * Verifies correcting a source path reuses the service selected by name-and-unit identity and stale managed services
 * are removed without touching services that belong to another plugin.
 * </summary>
 * @returns {void}
 */
function serviceManagerReusesIdentityAndRemovesOnlyManagedServices() {
  const accessory = new AccessoryDouble();
  const manager = new WeatherValueServiceManager(
    accessory,
    createHapDouble(),
    createUnitRegistry(),
    {},
  );
  const original = createMapping('Temperature', '/wrong/path');
  const corrected = createMapping('Temperature', '/current/temperature_2m');

  manager.reconcile([original]);
  const originalService = accessory.services[0];
  const originalCharacteristic = originalService.characteristics[0];
  manager.reconcile([corrected]);

  assert.equal(original.key, corrected.key);
  assert.equal(accessory.services.length, 1);
  assert.equal(accessory.services[0], originalService);
  assert.equal(originalCharacteristic.removeOnGetCount, 1);

  accessory.services.push(new ServiceDouble('Stale', 'uuid:stale', createServiceSubtype('stale')));
  accessory.services.push(new ServiceDouble('Unrelated', 'uuid:other', 'other-plugin:service'));
  manager.reconcile([]);

  assert.equal(accessory.services.length, 1);
  assert.equal(accessory.services[0].subtype, 'other-plugin:service');
}

test('same-unit mappings create separate services and publish independently', sameUnitMappingsPublishIndependently);
test('service identity survives path changes and stale cleanup stays scoped', serviceManagerReusesIdentityAndRemovesOnlyManagedServices);
