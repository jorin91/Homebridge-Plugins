'use strict';

const {
  ACCESSORY_MANUFACTURER,
  ACCESSORY_MODEL,
  ACCESSORY_SERIAL_NUMBER,
  MANAGED_SERVICE_SUBTYPE_PREFIX,
} = require('../constants');
const {
  createWeatherValueService,
  getOrCreateWeatherValueCharacteristic,
  updateWeatherValueServiceName,
} = require('./weather-value-homekit-factory');
const { writeWarning } = require('../logging/log-writer');

const MANAGED_SUBTYPES_CONTEXT_KEY = 'jsgWeatherManagedServiceSubtypes';

/**
 * <summary>
 * Owns the custom HomeKit services and cached values attached to the plugin's single accessory. Each normalized
 * mapping receives one service named by the user, while reusable unit definitions control its characteristic
 * format and validation. Repeating the same unit therefore creates separate services on the same accessory.
 * </summary>
 */
class WeatherValueServiceManager {
  /**
   * <summary>
   * Creates a manager for one created or restored platform accessory. Source URLs, paths, and source documents are
   * deliberately never stored in accessory context; only the managed service subtype list is persisted.
   * </summary>
   * @param {object} accessory Homebridge platform accessory that owns all mapped weather services.
   * @param {object} hap Homebridge HAP namespace containing Service, Characteristic, and UUID support.
   * @param {object} unitRegistry Registry of plugin-owned compact unit definitions.
   * @param {object} log Homebridge logger or compatible logger.
   */
  constructor(accessory, hap, unitRegistry, log) {
    this.accessory = accessory;
    this.accessory.context = this.accessory.context || {};
    this.hap = hap;
    this.unitRegistry = unitRegistry;
    this.log = log;
    this.entries = new Map();
  }

  /**
   * <summary>
   * Updates standard Accessory Information fields for the logical JSG Weather accessory. Missing test-double
   * capabilities are tolerated without changing production metadata behavior.
   * </summary>
   * @param {string} name Current configured accessory display name.
   * @returns {void}
   * @sideEffect Updates standard HomeKit accessory metadata when available.
   */
  configureAccessoryInformation(name) {
    const Service = this.hap && this.hap.Service;
    const Characteristic = this.hap && this.hap.Characteristic;
    if (!Service || !Characteristic || !Service.AccessoryInformation) {
      return;
    }

    const information = this.accessory.getService(Service.AccessoryInformation);
    if (!information || typeof information.setCharacteristic !== 'function') {
      return;
    }

    information
      .setCharacteristic(Characteristic.Manufacturer, ACCESSORY_MANUFACTURER)
      .setCharacteristic(Characteristic.Model, ACCESSORY_MODEL)
      .setCharacteristic(Characteristic.SerialNumber, ACCESSORY_SERIAL_NUMBER)
      .setCharacteristic(Characteristic.Name, name);
  }

  /**
   * <summary>
   * Makes managed services exactly match normalized mappings. Services are restored by deterministic internal
   * subtype, obsolete services are removed, visible names are refreshed, and each characteristic starts at its
   * unit-specific neutral value until the first successful source refresh completes.
   * </summary>
   * @param {ReadonlyArray<{key: string, name: string, unit: string, path: string}>} mappings Valid mappings.
   * @returns {void}
   * @sideEffect Adds, reuses, initializes, renames, or removes plugin-owned HomeKit services.
   */
  reconcile(mappings) {
    this.dispose();

    const expectedSubtypes = new Set();
    for (const mapping of mappings) {
      expectedSubtypes.add(createServiceSubtype(mapping.key));
    }

    this.removeStaleServices(expectedSubtypes);

    for (const mapping of mappings) {
      const definition = this.unitRegistry.get(mapping.unit);
      if (!definition) {
        continue;
      }

      const service = this.getOrCreateService(mapping);
      updateWeatherValueServiceName(service, this.hap, mapping.name);
      const characteristic = getOrCreateWeatherValueCharacteristic(
        service,
        this.hap,
        definition,
        mapping.name,
        mapping.unit,
      );

      const entry = {
        mapping,
        definition,
        characteristic,
        value: definition.neutralValue,
        getHandler: undefined,
        legacyGetHandler: undefined,
      };

      this.bindCachedRead(entry);
      this.entries.set(mapping.key, entry);
      this.updateCharacteristic(entry, definition.neutralValue);
    }

    this.accessory.context[MANAGED_SUBTYPES_CONTEXT_KEY] = Array.from(expectedSubtypes);
  }

  /**
   * <summary>
   * Publishes one normalized value to the characteristic belonging to an internal mapping key and replaces the
   * value returned by cached reads. Mapping keys distinguish repeated units without being exposed to users.
   * </summary>
   * @param {string} mappingKey Deterministic internal mapping identity.
   * @param {unknown} value Value already normalized by the mapping's unit definition.
   * @returns {void}
   * @sideEffect Updates one HomeKit characteristic when the mapping is active.
   */
  publish(mappingKey, value) {
    const entry = this.entries.get(mappingKey);
    if (!entry) {
      return;
    }

    entry.value = value;
    this.updateCharacteristic(entry, value);
  }

  /**
   * <summary>
   * Replaces one active mapping with the explicit neutral fallback owned by its configured unit definition.
   * </summary>
   * @param {string} mappingKey Deterministic internal mapping identity.
   * @returns {void}
   * @sideEffect Updates one active characteristic when the mapping exists.
   */
  publishNeutral(mappingKey) {
    const entry = this.entries.get(mappingKey);
    if (entry) {
      this.publish(mappingKey, entry.definition.neutralValue);
    }
  }

  /**
   * <summary>
   * Publishes explicit unit-specific neutral values for all active mappings after a complete transport or parsing
   * failure. Repeated units remain independent because publication uses each mapping's internal key.
   * </summary>
   * @param {ReadonlyArray<{key: string}>} mappings Active normalized mappings.
   * @returns {void}
   * @sideEffect Updates every active cached and published value.
   */
  publishAllNeutral(mappings) {
    for (const mapping of mappings) {
      this.publishNeutral(mapping.key);
    }
  }

  /**
   * <summary>
   * Detaches read handlers owned by this manager before runtime replacement or shutdown. Services and their last
   * values remain attached until the next explicit reconciliation.
   * </summary>
   * @returns {void}
   * @sideEffect Removes registered HomeKit get handlers when the characteristic API supports it.
   */
  dispose() {
    for (const entry of this.entries.values()) {
      if (entry.getHandler && typeof entry.characteristic.removeOnGet === 'function') {
        entry.characteristic.removeOnGet();
      }
      if (entry.legacyGetHandler && typeof entry.characteristic.removeListener === 'function') {
        entry.characteristic.removeListener('get', entry.legacyGetHandler);
      }
    }

    this.entries.clear();
  }

  /**
   * <summary>
   * Removes only plugin-managed services whose subtypes no longer occur in the normalized mapping set. A snapshot is
   * used so adjacent removals cannot be skipped while the accessory's service collection changes.
   * </summary>
   * @param {Set<string>} expectedSubtypes Managed subtypes required by the new configuration.
   * @returns {void}
   * @sideEffect Removes stale plugin-owned services from the accessory.
   */
  removeStaleServices(expectedSubtypes) {
    const recordedSubtypes = Array.isArray(this.accessory.context[MANAGED_SUBTYPES_CONTEXT_KEY])
      ? this.accessory.context[MANAGED_SUBTYPES_CONTEXT_KEY]
      : [];
    const knownSubtypes = new Set(recordedSubtypes);
    const attachedServices = Array.from(this.accessory.services || []);

    for (const service of attachedServices) {
      const subtype = service && service.subtype;
      const isManaged =
        typeof subtype === 'string' &&
        (subtype.startsWith(MANAGED_SERVICE_SUBTYPE_PREFIX) || knownSubtypes.has(subtype));

      if (isManaged && !expectedSubtypes.has(subtype)) {
        this.accessory.removeService(service);
      }
    }
  }

  /**
   * <summary>
   * Reuses a restored custom weather value service by deterministic mapping subtype or creates a new generic custom
   * service named after the configured measurement. The source path never affects this identity.
   * </summary>
   * @param {{key: string, name: string}} mapping Normalized mapping requiring a service.
   * @returns {object} Existing or newly attached HomeKit service.
   * @sideEffect May attach one custom service to the accessory.
   */
  getOrCreateService(mapping) {
    const subtype = createServiceSubtype(mapping.key);

    for (const service of this.accessory.services || []) {
      if (service && service.subtype === subtype) {
        return service;
      }
    }

    const service = createWeatherValueService(this.hap, mapping.name, subtype);
    this.accessory.addService(service);
    return service;
  }

  /**
   * <summary>
   * Registers one HomeKit read callback that returns cached state without network I/O. Promise-based onGet is
   * preferred, with the legacy callback event retained for compatible HAP implementations.
   * </summary>
   * @param {object} entry Managed mapping entry whose cached value changes over time.
   * @returns {void}
   * @sideEffect Registers exactly one read handler on the characteristic.
   */
  bindCachedRead(entry) {
    if (typeof entry.characteristic.onGet === 'function') {
      /**
       * <summary>
       * Returns the latest normalized or neutral value to a modern HomeKit read request.
       * </summary>
       * @returns {unknown} Current cached value for this mapping characteristic.
       */
      function readCachedValue() {
        return entry.value;
      }

      entry.getHandler = readCachedValue;
      entry.characteristic.onGet(entry.getHandler);
      return;
    }

    if (typeof entry.characteristic.on === 'function') {
      /**
       * <summary>
       * Returns the latest cached value through the legacy callback-based HomeKit read contract.
       * </summary>
       * @param {Function} callback HAP callback receiving an error and cached value.
       * @returns {void}
       * @sideEffect Invokes the supplied callback exactly once.
       */
      function readCachedValueWithCallback(callback) {
        callback(null, entry.value);
      }

      entry.legacyGetHandler = readCachedValueWithCallback;
      entry.characteristic.on('get', entry.legacyGetHandler);
    }
  }

  /**
   * <summary>
   * Sends a value through the HomeKit characteristic update API while containing characteristic-specific failures.
   * </summary>
   * @param {object} entry Managed mapping entry.
   * @param {unknown} value Normalized or neutral value to publish.
   * @returns {void}
   * @sideEffect Invokes the HomeKit characteristic update method when available.
   */
  updateCharacteristic(entry, value) {
    try {
      if (typeof entry.characteristic.updateValue === 'function') {
        entry.characteristic.updateValue(value);
      }
    } catch {
      writeWarning(
        this.log,
        `Unable to publish weather mapping ${entry.mapping.name} with unit ${entry.mapping.unit} to HomeKit`,
      );
    }
  }
}

/**
 * <summary>
 * Creates the stable managed-service subtype from an opaque internal mapping key. Raw names, unit symbols, and
 * provider paths never appear in the HomeKit subtype or accessory context.
 * </summary>
 * @param {string} mappingKey Deterministic hexadecimal mapping identity.
 * @returns {string} Plugin-managed service subtype.
 */
function createServiceSubtype(mappingKey) {
  return `${MANAGED_SERVICE_SUBTYPE_PREFIX}${mappingKey}`;
}

module.exports = {
  WeatherValueServiceManager,
  createServiceSubtype,
  MANAGED_SUBTYPES_CONTEXT_KEY,
};
