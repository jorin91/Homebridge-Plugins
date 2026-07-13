'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ACCESSORY_UUID_SEED, PLUGIN_NAME, PLATFORM_NAME } = require('../lib/constants');
const { WeatherPlatform } = require('../lib/platform/weather-platform');
const { createDefaultSourceFormatRegistry } = require('../lib/sources/source-format-registry');
const { WeatherUnitRegistry } = require('../lib/units/weather-unit-registry');

/**
 * <summary>
 * Converts one platform test value into a finite number for the injected Celsius unit definition.
 * </summary>
 * @param {unknown} value Raw source value.
 * @returns {number} Finite numeric source value.
 * @throws {TypeError} When the value is not finite.
 */
function normalizePlatformTestValue(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) {
    throw new TypeError('Expected a finite number');
  }
  return normalized;
}

/**
 * <summary>
 * Creates one explicit test unit used to determine whether platform mappings are valid.
 * </summary>
 * @returns {WeatherUnitRegistry} Test-only registry supporting Celsius and no other units.
 */
function createPlatformUnitRegistry() {
  return new WeatherUnitRegistry([
    {
      unit: '°C',
      automationKind: 'numeric',
      characteristicUuid: 'uuid:test:celsius',
      characteristicProps: {
        format: 'float',
        unit: 'celsius',
        perms: ['pr', 'ev'],
      },
      normalize: normalizePlatformTestValue,
      neutralValue: -273.15,
    },
  ]);
}

/**
 * <summary>
 * Models the minimal platform accessory state used by lifecycle reconciliation tests.
 * </summary>
 */
class TestPlatformAccessory {
  /**
   * <summary>
   * Creates a cached or newly registered test accessory with its display name and deterministic UUID.
   * </summary>
   * @param {string} displayName Accessory display name.
   * @param {string} UUID Deterministic accessory UUID.
   */
  constructor(displayName, UUID) {
    this.displayName = displayName;
    this.UUID = UUID;
    this.context = {};
    this.services = [];
  }
}

/**
 * <summary>
 * Creates a Homebridge API double that records lifecycle handlers and accessory persistence operations.
 * </summary>
 * @returns {object} API double with operation collections and deterministic UUID support.
 */
function createApiDouble() {
  const handlers = new Map();
  const registered = [];
  const unregistered = [];
  const updated = [];

  return {
    handlers,
    registered,
    unregistered,
    updated,
    platformAccessory: TestPlatformAccessory,
    hap: {
      uuid: {
        /**
         * <summary>
         * Generates a stable readable UUID double from the plugin's internal identity seed.
         * </summary>
         * @param {string} seed Stable UUID seed.
         * @returns {string} Deterministic UUID double.
         */
        generate(seed) {
          return `uuid:${seed}`;
        },
      },
    },

    /**
     * <summary>
     * Records one Homebridge lifecycle callback by event name.
     * </summary>
     * @param {string} event Lifecycle event name.
     * @param {Function} handler Bound platform callback.
     * @returns {void}
     * @sideEffect Stores the callback for test inspection.
     */
    on(event, handler) {
      handlers.set(event, handler);
    },

    /**
     * <summary>
     * Records newly registered dynamic platform accessories.
     * </summary>
     * @param {string} pluginName Homebridge plugin identifier.
     * @param {string} platformName Homebridge platform alias.
     * @param {ReadonlyArray<object>} accessories Newly registered accessories.
     * @returns {void}
     * @sideEffect Appends a registration operation.
     */
    registerPlatformAccessories(pluginName, platformName, accessories) {
      registered.push({ pluginName, platformName, accessories });
    },

    /**
     * <summary>
     * Records cached dynamic platform accessories removed during reconciliation.
     * </summary>
     * @param {string} pluginName Homebridge plugin identifier.
     * @param {string} platformName Homebridge platform alias.
     * @param {ReadonlyArray<object>} accessories Removed accessories.
     * @returns {void}
     * @sideEffect Appends an unregistration operation.
     */
    unregisterPlatformAccessories(pluginName, platformName, accessories) {
      unregistered.push({ pluginName, platformName, accessories });
    },

    /**
     * <summary>
     * Records persisted updates to the retained singleton accessory.
     * </summary>
     * @param {ReadonlyArray<object>} accessories Updated accessories.
     * @returns {void}
     * @sideEffect Appends an update operation.
     */
    updatePlatformAccessories(accessories) {
      updated.push(accessories);
    },
  };
}

/**
 * <summary>
 * Creates a logger double that records platform information and mapping warnings.
 * </summary>
 * @returns {object} Logger double with captured messages.
 */
function createPlatformLogger() {
  const information = [];
  const warnings = [];

  return {
    information,
    warnings,

    /**
     * <summary>
     * Records one informational platform message.
     * </summary>
     * @param {string} message Informational text.
     * @returns {void}
     * @sideEffect Appends the message to the information collection.
     */
    info(message) {
      information.push(message);
    },

    /**
     * <summary>
     * Records one platform or configuration warning.
     * </summary>
     * @param {string} message Warning text.
     * @returns {void}
     * @sideEffect Appends the message to the warning collection.
     */
    warn(message) {
      warnings.push(message);
    },
  };
}

/**
 * <summary>
 * Creates injected platform collaborators and records every runtime instance that starts or stops.
 * </summary>
 * @param {WeatherUnitRegistry} unitRegistry Unit registry injected into the platform.
 * @returns {object} Dependency object and runtime record collection.
 */
function createPlatformDependencies(unitRegistry) {
  const runtimeRecords = [];

  /**
   * <summary>
   * Creates a source client marker without performing network access.
   * </summary>
   * @returns {object} Source client marker.
   */
  function sourceClientFactory() {
    return { kind: 'source-client-double' };
  }

  /**
   * <summary>
   * Creates a service manager marker for the retained accessory.
   * </summary>
   * @param {object} accessory Retained platform accessory.
   * @returns {object} Service manager marker tied to the accessory.
   */
  function serviceManagerFactory(accessory) {
    return { kind: 'service-manager-double', accessory };
  }

  /**
   * <summary>
   * Creates a runtime double that records start and stop operations for one reconciled accessory.
   * </summary>
   * @param {object} options Runtime construction options supplied by the platform.
   * @returns {object} Stoppable runtime double.
   * @sideEffect Appends one runtime record to the shared collection.
   */
  function runtimeFactory(options) {
    const record = {
      options,
      startCalls: 0,
      stopCalls: 0,

      /**
       * <summary>
       * Records activation of the reconciled weather runtime.
       * </summary>
       * @returns {void}
       * @sideEffect Increments the runtime start counter.
       */
      start() {
        record.startCalls += 1;
      },

      /**
       * <summary>
       * Records shutdown or replacement of the reconciled weather runtime.
       * </summary>
       * @returns {void}
       * @sideEffect Increments the runtime stop counter.
       */
      stop() {
        record.stopCalls += 1;
      },
    };

    runtimeRecords.push(record);
    return record;
  }

  return {
    runtimeRecords,
    dependencies: {
      unitRegistry,
      sourceFormatRegistry: createDefaultSourceFormatRegistry(),
      sourceClientFactory,
      serviceManagerFactory,
      runtimeFactory,
    },
  };
}

/**
 * <summary>
 * Verifies an unsupported configured unit invalidates its only mapping, prevents accessory creation, and removes a
 * restored plugin accessory because no valid reading remains.
 * </summary>
 * @returns {void}
 */
function weatherPlatformCreatesNoAccessoryForInvalidUnit() {
  const api = createApiDouble();
  const logger = createPlatformLogger();
  const setup = createPlatformDependencies(createPlatformUnitRegistry());
  const cachedAccessory = new TestPlatformAccessory('Old weather', 'old-weather-uuid');
  const platform = new WeatherPlatform(
    logger,
    {
      sourceType: 'json',
      source: 'https://api.example.test/weather',
      interval: 5,
      name: 'Weather',
      mappings: [{ name: 'Temperature', unit: 'K', path: '/current/temperature_2m' }],
    },
    api,
    setup.dependencies,
  );

  platform.configureAccessory(cachedAccessory);
  platform.didFinishLaunching();

  assert.equal(api.registered.length, 0);
  assert.equal(api.updated.length, 0);
  assert.equal(api.unregistered.length, 1);
  assert.deepEqual(api.unregistered[0], {
    pluginName: PLUGIN_NAME,
    platformName: PLATFORM_NAME,
    accessories: [cachedAccessory],
  });
  assert.equal(setup.runtimeRecords.length, 0);
  assert.deepEqual(platform.cachedAccessories, []);
  assert.match(logger.warnings.join('\n'), /unsupported unit K/);
}

/**
 * <summary>
 * Verifies one valid named unit mapping creates exactly one deterministic accessory and a later platform instance
 * reuses that singleton while passing the unit registry and normalized configuration into its runtime.
 * </summary>
 * @returns {void}
 */
function weatherPlatformCreatesAndReusesAccessoryForValidUnit() {
  const unitRegistry = createPlatformUnitRegistry();
  const firstApi = createApiDouble();
  const firstSetup = createPlatformDependencies(unitRegistry);
  const config = {
    sourceType: 'json',
    source: 'https://api.example.test/weather',
    interval: 5,
    name: 'Weather Test Site',
    mappings: [
      { name: 'Temperature', unit: '°C', path: '/current/temperature_2m' },
      { name: 'Dew point', unit: '°C', path: '/current/dew_point_2m' },
    ],
  };
  const firstPlatform = new WeatherPlatform(
    createPlatformLogger(),
    config,
    firstApi,
    firstSetup.dependencies,
  );

  firstPlatform.didFinishLaunching();

  const expectedUuid = `uuid:${ACCESSORY_UUID_SEED}`;
  assert.equal(firstApi.registered.length, 1);
  assert.equal(firstApi.registered[0].pluginName, PLUGIN_NAME);
  assert.equal(firstApi.registered[0].platformName, PLATFORM_NAME);
  assert.equal(firstApi.registered[0].accessories.length, 1);

  const createdAccessory = firstApi.registered[0].accessories[0];
  assert.equal(createdAccessory.UUID, expectedUuid);
  assert.equal(createdAccessory.displayName, 'Weather Test Site');
  assert.deepEqual(firstPlatform.cachedAccessories, [createdAccessory]);
  assert.equal(firstSetup.runtimeRecords.length, 1);
  assert.equal(firstSetup.runtimeRecords[0].options.unitRegistry, unitRegistry);
  assert.equal(firstSetup.runtimeRecords[0].options.config.mappings.length, 2);
  assert.notEqual(
    firstSetup.runtimeRecords[0].options.config.mappings[0].key,
    firstSetup.runtimeRecords[0].options.config.mappings[1].key,
  );
  assert.equal(firstSetup.runtimeRecords[0].startCalls, 1);

  const secondApi = createApiDouble();
  const secondSetup = createPlatformDependencies(unitRegistry);
  const secondPlatform = new WeatherPlatform(
    createPlatformLogger(),
    { ...config, name: 'Weather reused' },
    secondApi,
    secondSetup.dependencies,
  );
  const staleDuplicate = new TestPlatformAccessory('Duplicate', 'stale-uuid');

  secondPlatform.configureAccessory(createdAccessory);
  secondPlatform.configureAccessory(staleDuplicate);
  secondPlatform.didFinishLaunching();

  assert.equal(secondApi.registered.length, 0);
  assert.equal(secondApi.unregistered.length, 1);
  assert.deepEqual(secondApi.unregistered[0].accessories, [staleDuplicate]);
  assert.deepEqual(secondApi.updated, [[createdAccessory]]);
  assert.deepEqual(secondPlatform.cachedAccessories, [createdAccessory]);
  assert.equal(createdAccessory.UUID, expectedUuid);
  assert.equal(createdAccessory.displayName, 'Weather reused');
  assert.equal(secondSetup.runtimeRecords.length, 1);
  assert.equal(secondSetup.runtimeRecords[0].options.serviceManager.accessory, createdAccessory);
  assert.equal(secondSetup.runtimeRecords[0].startCalls, 1);
}

test('weather platform creates no accessory for an invalid unit', weatherPlatformCreatesNoAccessoryForInvalidUnit);
test('weather platform creates and reuses one accessory for valid units', weatherPlatformCreatesAndReusesAccessoryForValidUnit);
