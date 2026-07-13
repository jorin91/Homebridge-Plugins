'use strict';

const {
  ACCESSORY_UUID_SEED,
  PLUGIN_NAME,
  PLATFORM_NAME,
} = require('../constants');
const { normalizeWeatherConfig } = require('../config/weather-config');
const { WeatherValueServiceManager } = require('../homekit/weather-value-service-manager');
const { writeInfo } = require('../logging/log-writer');
const { HttpSourceClient } = require('../sources/http-source-client');
const { createDefaultSourceFormatRegistry } = require('../sources/source-format-registry');
const { createDefaultWeatherUnitRegistry } = require('../units/weather-unit-registry');
const { WeatherAccessoryRuntime } = require('../runtime/weather-accessory-runtime');

/**
 * <summary>
 * Implements the single-accessory Homebridge dynamic platform. The platform owns one deterministic accessory UUID,
 * restores that accessory across restarts, removes duplicates, and creates it only when at least one mapping is
 * valid against an implemented source format and a plugin-owned compact unit definition.
 * </summary>
 */
class WeatherPlatform {
  /**
   * <summary>
   * Creates the platform, prepares the source and unit registries, and subscribes to Homebridge lifecycle events.
   * The optional dependency object supports isolated tests without changing the public Homebridge constructor.
   * </summary>
   * @param {object} log Homebridge platform logger.
   * @param {object} config User configuration block.
   * @param {object} api Homebridge API including the HAP namespace used for stable custom characteristic UUIDs.
   * @param {object} [dependencies] Optional factories and registries used by tests or future composition.
   */
  constructor(log, config, api, dependencies = {}) {
    this.log = log;
    this.rawConfig = config;
    this.api = api;
    this.unitRegistry =
      dependencies.unitRegistry || createDefaultWeatherUnitRegistry(this.api.hap);
    this.sourceFormatRegistry =
      dependencies.sourceFormatRegistry || createDefaultSourceFormatRegistry();
    this.sourceClientFactory = dependencies.sourceClientFactory || createHttpSourceClient;
    this.serviceManagerFactory =
      dependencies.serviceManagerFactory || createWeatherValueServiceManager;
    this.runtimeFactory = dependencies.runtimeFactory || createWeatherAccessoryRuntime;
    this.cachedAccessories = [];
    this.runtime = undefined;

    this.api.on('didFinishLaunching', this.didFinishLaunching.bind(this));
    this.api.on('shutdown', this.shutdown.bind(this));
  }

  /**
   * <summary>
   * Receives each cached platform accessory during Homebridge startup. Reconciliation is delayed until all cached
   * accessories have been supplied by Homebridge.
   * </summary>
   * @param {object} accessory Restored Homebridge platform accessory.
   * @returns {void}
   * @sideEffect Adds the accessory to the temporary startup cache.
   */
  configureAccessory(accessory) {
    this.cachedAccessories.push(accessory);
  }

  /**
   * <summary>
   * Normalizes configuration and reconciles the deterministic singleton accessory after Homebridge completes cache
   * restoration. With no valid named unit mappings, cached plugin accessories are unregistered and none is created.
   * </summary>
   * @returns {void}
   * @sideEffect May register, update, unregister, and start polling for the single weather accessory.
   */
  didFinishLaunching() {
    this.stopRuntime();

    const config = normalizeWeatherConfig(this.rawConfig, {
      sourceFormatRegistry: this.sourceFormatRegistry,
      unitRegistry: this.unitRegistry,
      log: this.log,
    });

    if (config.mappings.length === 0) {
      this.unregisterAccessories(this.cachedAccessories);
      this.cachedAccessories = [];
      writeInfo(this.log, 'No valid weather mappings are configured, so no accessory was created');
      return;
    }

    const expectedUuid = this.api.hap.uuid.generate(ACCESSORY_UUID_SEED);
    let accessory;

    for (const candidate of this.cachedAccessories) {
      if (candidate.UUID === expectedUuid) {
        accessory = candidate;
        break;
      }
    }

    if (!accessory) {
      accessory = new this.api.platformAccessory(config.name, expectedUuid);
    }

    const staleAccessories = [];
    for (const candidate of this.cachedAccessories) {
      if (candidate !== accessory) {
        staleAccessories.push(candidate);
      }
    }

    this.unregisterAccessories(staleAccessories);

    if (!this.cachedAccessories.includes(accessory)) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    accessory.displayName = config.name;
    accessory.context = accessory.context || {};
    this.cachedAccessories = [accessory];
    this.api.updatePlatformAccessories([accessory]);

    const sourceClient = this.sourceClientFactory();
    const serviceManager = this.serviceManagerFactory(
      accessory,
      this.api.hap,
      this.unitRegistry,
      this.log,
    );

    this.runtime = this.runtimeFactory({
      config,
      unitRegistry: this.unitRegistry,
      sourceFormatRegistry: this.sourceFormatRegistry,
      sourceClient,
      serviceManager,
      log: this.log,
    });
    this.runtime.start();
  }

  /**
   * <summary>
   * Stops active weather polling and network work when Homebridge begins shutdown.
   * </summary>
   * @returns {void}
   * @sideEffect Stops the current accessory runtime when one exists.
   */
  shutdown() {
    this.stopRuntime();
  }

  /**
   * <summary>
   * Stops and releases the current accessory runtime before shutdown or replacement.
   * </summary>
   * @returns {void}
   * @sideEffect Cancels current polling and source transport when active.
   */
  stopRuntime() {
    if (this.runtime) {
      this.runtime.stop();
      this.runtime = undefined;
    }
  }

  /**
   * <summary>
   * Unregisters a known list of stale or no-longer-configured plugin accessories as one Homebridge operation.
   * </summary>
   * @param {ReadonlyArray<object>} accessories Cached plugin accessories to remove.
   * @returns {void}
   * @sideEffect Removes supplied platform accessories from Homebridge persistence when the list is non-empty.
   */
  unregisterAccessories(accessories) {
    if (accessories.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessories);
    }
  }
}

/**
 * <summary>
 * Creates the production dependency-free HTTP text client using Node.js global fetch.
 * </summary>
 * @returns {HttpSourceClient} New source transport client for one accessory runtime.
 */
function createHttpSourceClient() {
  return new HttpSourceClient();
}

/**
 * <summary>
 * Creates the HomeKit service manager for the platform's single accessory and complete reusable unit registry.
 * </summary>
 * @param {object} accessory Homebridge platform accessory.
 * @param {object} hap Homebridge HAP namespace.
 * @param {object} unitRegistry Plugin-owned compact unit registry.
 * @param {object} log Homebridge logger.
 * @returns {WeatherValueServiceManager} Configured value service manager.
 */
function createWeatherValueServiceManager(accessory, hap, unitRegistry, log) {
  return new WeatherValueServiceManager(accessory, hap, unitRegistry, log);
}

/**
 * <summary>
 * Creates the production runtime connecting polling, source formats, units, transport, and HomeKit values.
 * </summary>
 * @param {object} options WeatherAccessoryRuntime constructor options.
 * @returns {WeatherAccessoryRuntime} Configured runtime for the singleton accessory.
 */
function createWeatherAccessoryRuntime(options) {
  return new WeatherAccessoryRuntime(options);
}

module.exports = {
  WeatherPlatform,
  createHttpSourceClient,
  createWeatherValueServiceManager,
  createWeatherAccessoryRuntime,
};
