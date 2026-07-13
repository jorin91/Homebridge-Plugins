'use strict';

const { PLUGIN_NAME } = require('../constants');

/**
 * <summary>
 * Creates one generic custom HomeKit service for a named weather mapping. Every mapping receives its own service so
 * multiple readings may reuse the same unit-characteristic UUID without violating HomeKit's one-characteristic-UUID
 * per service rule. All created services still belong to the plugin's single accessory.
 * </summary>
 * @param {object} hap Homebridge HAP namespace containing the base Service class and UUID generator.
 * @param {string} name User-selected visible measurement name.
 * @param {string} subtype Stable internal service subtype derived from mapping name and unit.
 * @returns {object} Newly constructed custom weather value service.
 */
function createWeatherValueService(hap, name, subtype) {
  const serviceUuid = hap.uuid.generate(`${PLUGIN_NAME}:weather-value-service`);
  return new hap.Service(name, serviceUuid, subtype);
}

/**
 * <summary>
 * Retrieves the unit characteristic already restored on a managed service or creates it from the unit definition.
 * The configured mapping name is applied to the characteristic display name and description each reconciliation,
 * while the compact unit is preserved in HomeKit metadata for compatible third-party clients.
 * </summary>
 * @param {object} service Existing or newly created managed weather value service.
 * @param {object} hap Homebridge HAP namespace containing the base Characteristic class.
 * @param {object} definition Immutable unit definition from the weather unit registry.
 * @param {string} name User-selected visible measurement name.
 * @param {string} unit Compact configured unit symbol.
 * @returns {object} Restored or newly attached custom unit characteristic.
 * @sideEffect May add one characteristic to the supplied service and refresh its presentation metadata.
 */
function getOrCreateWeatherValueCharacteristic(service, hap, definition, name, unit) {
  let characteristic;

  for (const candidate of service.characteristics || []) {
    if (candidate && candidate.UUID === definition.characteristicUuid) {
      characteristic = candidate;
      break;
    }
  }

  const props = {
    ...definition.characteristicProps,
    description: `${name} (${unit})`,
  };

  if (!characteristic) {
    characteristic = new hap.Characteristic(name, definition.characteristicUuid, props);
    service.addCharacteristic(characteristic);
  } else {
    characteristic.displayName = name;
    if (typeof characteristic.setProps === 'function') {
      characteristic.setProps(props);
    }
  }

  return characteristic;
}

/**
 * <summary>
 * Updates the visible name of a restored custom service without changing its UUID or subtype. This is defensive for
 * cached accessories whose HomeKit service object predates the current configuration reconciliation.
 * </summary>
 * @param {object} service Managed custom weather service.
 * @param {object} hap Homebridge HAP namespace containing the standard Name characteristic constructor.
 * @param {string} name User-selected visible measurement name.
 * @returns {void}
 * @sideEffect Updates service display metadata and its standard Name characteristic when supported.
 */
function updateWeatherValueServiceName(service, hap, name) {
  service.displayName = name;

  const NameCharacteristic = hap && hap.Characteristic && hap.Characteristic.Name;
  if (NameCharacteristic && typeof service.setCharacteristic === 'function') {
    service.setCharacteristic(NameCharacteristic, name);
  }
}

module.exports = {
  createWeatherValueService,
  getOrCreateWeatherValueCharacteristic,
  updateWeatherValueServiceName,
};
