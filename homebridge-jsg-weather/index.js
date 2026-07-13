'use strict';

const { PLUGIN_NAME, PLATFORM_NAME } = require('./lib/constants');
const { WeatherPlatform } = require('./lib/platform/weather-platform');

/**
 * <summary>
 * Registers the JSG Weather dynamic platform with Homebridge. Platform construction and all operational behavior
 * remain in focused modules so the package entry point has only registration responsibility.
 * </summary>
 * @param {object} homebridge Homebridge registration API supplied while loading the plugin.
 * @returns {void}
 * @sideEffect Registers one dynamic platform constructor under the package and platform names.
 */
function registerWeatherPlatform(homebridge) {
  homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, WeatherPlatform);
}

module.exports = registerWeatherPlatform;
