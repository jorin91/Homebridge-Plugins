'use strict';

/**
 * <summary>
 * Defines the immutable identity, defaults, limits, and HomeKit metadata shared by the weather plugin.
 * Keeping these values in one module prevents platform registration, accessory restoration, polling, and
 * configuration normalization from silently drifting apart.
 * </summary>
 */
module.exports = Object.freeze({
  PLUGIN_NAME: 'homebridge-jsg-weather',
  PLATFORM_NAME: 'JsgWeather',
  DISPLAY_NAME: 'JSG Weather',
  DEFAULT_ACCESSORY_NAME: 'Weather',
  DEFAULT_SOURCE_TYPE: 'json',
  DEFAULT_INTERVAL_MINUTES: 5,
  MIN_INTERVAL_MINUTES: 1,
  MAX_INTERVAL_MINUTES: 1440,
  DEFAULT_REQUEST_TIMEOUT_MS: 15000,
  MAX_SOURCE_BODY_BYTES: 1024 * 1024,
  ACCESSORY_UUID_SEED: 'homebridge-jsg-weather:primary-weather-accessory',
  MANAGED_SERVICE_SUBTYPE_PREFIX: 'jsg-weather:',
  ACCESSORY_MANUFACTURER: 'JSG',
  ACCESSORY_MODEL: 'JSG Weather',
  ACCESSORY_SERIAL_NUMBER: 'homebridge-jsg-weather-primary',
});
