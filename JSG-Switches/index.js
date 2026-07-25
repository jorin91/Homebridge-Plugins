'use strict';

const fs = require('fs');
const path = require('path');
const { createGeneratedIdentifier, ensureStableDeviceIds, normalizeIdentifier } = require('./lib/config-identity');
const schedule = require('./lib/schedule');

const PLUGIN_NAME = 'homebridge-jsg-switches';
const PLATFORM_NAME = 'JSG-Switches';
const MANUFACTURER = 'JSGaming';
const STATE_FILE_NAME = `${PLUGIN_NAME}-state.json`;
const DEFAULT_INTERVAL_MINUTES = 15;
const DEFAULT_TIMER_MINUTES = 30;
const MIN_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 1440;
const MILLISECONDS_PER_MINUTE = 60 * 1000;

const TYPE_SCHEDULED = 'scheduledSwitch';
const TYPE_SWITCH = 'switch';
const TYPE_INTERVAL = 'intervalSwitch';
const TYPE_TIMER = 'timerSwitch';

const DEVICE_COLLECTIONS = Object.freeze([
  {
    key: 'scheduledSwitches',
    type: TYPE_SCHEDULED,
    defaultName: 'Scheduled Switch',
    fallbackId: 'scheduled-switch'
  },
  {
    key: 'switches',
    type: TYPE_SWITCH,
    defaultName: 'Switch',
    fallbackId: 'switch'
  },
  {
    key: 'intervalSwitches',
    type: TYPE_INTERVAL,
    defaultName: 'Interval Switch',
    fallbackId: 'interval-switch'
  },
  {
    key: 'timerSwitches',
    type: TYPE_TIMER,
    defaultName: 'Timer Switch',
    fallbackId: 'timer-switch'
  }
]);

let Service;
let Characteristic;

module.exports = function registerJsgSwitchesPlatform(homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;

  homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, JsgSwitchesPlatform);
};

class JsgSwitchesPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.cachedAccessories = new Map();
    this.deviceRuntimes = new Map();
    this.stateStore = new StateStore(api, log);

    if (this.api && typeof this.api.on === 'function') {
      this.api.on('didFinishLaunching', this.syncConfiguredDevices.bind(this));
      this.api.on('shutdown', this.shutdown.bind(this));
    }
  }

  configureAccessory(accessory) {
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  syncConfiguredDevices() {
    const legacyIdentityCandidates = collectLegacyIdentityCandidates(this.config);

    ensureStableDeviceIds({
      config: this.config,
      api: this.api,
      log: this.log,
      platformName: PLATFORM_NAME,
      collections: DEVICE_COLLECTIONS,
      pluginName: PLUGIN_NAME
    });

    const configuredDevices = normalizePlatformConfig(this.config, this.log, legacyIdentityCandidates);
    const configuredIds = new Set(configuredDevices.map((device) => device.id));
    const configuredUuids = new Set();

    configuredDevices.forEach((deviceConfig) => {
      const targetUuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${deviceConfig.id}`);
      let accessory = this.findCachedAccessory(deviceConfig, targetUuid, configuredIds, configuredUuids);
      const matchedCachedAccessory = Boolean(accessory);

      if (!accessory && this.cachedAccessories.has(targetUuid)) {
        writeWarning(this.log, `${PLATFORM_NAME} device '${deviceConfig.name}' uses an ID whose UUID is retained by another configured accessory and was skipped.`);
        return;
      }

      if (!accessory) {
        accessory = new this.api.platformAccessory(deviceConfig.name, targetUuid);
        this.cachedAccessories.set(targetUuid, accessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        writeInfo(this.log, `Created ${formatDeviceType(deviceConfig.type)} '${deviceConfig.name}'.`);
      }

      configuredUuids.add(accessory.UUID);
      accessory.context.deviceId = deviceConfig.id;
      accessory.context.deviceType = deviceConfig.type;
      accessory.context.deviceConfig = deviceConfig;

      if (typeof accessory.updateDisplayName === 'function') {
        accessory.updateDisplayName(deviceConfig.name);
      } else {
        accessory.displayName = deviceConfig.name;
      }

      if (matchedCachedAccessory && (deviceConfig.type === TYPE_SWITCH || deviceConfig.type === TYPE_INTERVAL)) {
        this.stateStore.preserveStateForIdChange(deviceConfig.legacyId, deviceConfig.id);
      }

      this.startOrUpdateDevice(accessory, deviceConfig);

      if (typeof this.api.updatePlatformAccessories === 'function') {
        this.api.updatePlatformAccessories([accessory]);
      }
    });

    Array.from(this.cachedAccessories.entries()).forEach(([uuid, accessory]) => {
      if (configuredUuids.has(uuid)) {
        return;
      }

      const runtime = this.deviceRuntimes.get(uuid);

      if (runtime) {
        runtime.stop();
        this.deviceRuntimes.delete(uuid);
      }

      this.cachedAccessories.delete(uuid);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      writeInfo(this.log, `Removed switch '${accessory.displayName || uuid}'.`);
    });
  }

  /**
   * <summary>
   * Finds the cached accessory represented by a normalized config ID. Persisted
   * accessory context is checked first because retained accessories can keep a
   * previous Homebridge UUID. A direct UUID match handles current accessories.
   * Previous context and UUID candidates then preserve the same logical device,
   * after which updated context keeps future renames and settings changes stable.
   * </summary>
   * @param {object} deviceConfig Normalized device configuration.
   * @param {string} targetUuid UUID generated from the current stable ID.
   * @param {Set<string>} configuredIds All authoritative IDs in the current valid config.
   * @param {Set<string>} claimedUuids Cached accessory UUIDs already assigned during this reconciliation.
   * @returns {object|null} Matching cached accessory or null when a new one is required.
   */
  findCachedAccessory(deviceConfig, targetUuid, configuredIds, claimedUuids) {
    const isUnclaimed = (accessory) => accessory && !claimedUuids.has(accessory.UUID);
    const isAvailableFallback = (accessory) => {
      if (!isUnclaimed(accessory)) {
        return false;
      }

      const cachedId = normalizeIdentifier(accessory.context && accessory.context.deviceId);

      return !cachedId || cachedId === deviceConfig.id || !configuredIds.has(cachedId);
    };
    const contextMatch = Array.from(this.cachedAccessories.values()).find((accessory) => {
      const cachedId = accessory && accessory.context && accessory.context.deviceId;

      return isUnclaimed(accessory) && normalizeIdentifier(cachedId) === deviceConfig.id;
    });

    if (contextMatch) {
      return contextMatch;
    }

    const directMatch = this.cachedAccessories.get(targetUuid);

    if (isAvailableFallback(directMatch)) {
      return directMatch;
    }

    if (!deviceConfig.legacyId) {
      return null;
    }

    const legacyContextMatch = Array.from(this.cachedAccessories.values()).find((accessory) => {
      const cachedId = accessory && accessory.context && accessory.context.deviceId;

      return isAvailableFallback(accessory) && createLegacyIdentifier(cachedId) === deviceConfig.legacyId;
    });

    if (legacyContextMatch) {
      return legacyContextMatch;
    }

    const legacyUuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${deviceConfig.legacyId}`);
    const legacyUuidMatch = this.cachedAccessories.get(legacyUuid);

    return isAvailableFallback(legacyUuidMatch) ? legacyUuidMatch : null;
  }

  startOrUpdateDevice(accessory, deviceConfig) {
    const existingRuntime = this.deviceRuntimes.get(accessory.UUID);

    if (existingRuntime && existingRuntime.type === deviceConfig.type) {
      existingRuntime.updateConfig(deviceConfig);
      return;
    }

    if (existingRuntime) {
      existingRuntime.stop();
      this.deviceRuntimes.delete(accessory.UUID);
    }

    this.deviceRuntimes.set(accessory.UUID, createDeviceRuntime(this, accessory, deviceConfig));
  }

  shutdown() {
    this.deviceRuntimes.forEach((runtime) => runtime.stop());
    this.deviceRuntimes.clear();
  }
}

class BaseSwitchDevice {
  constructor(platform, accessory, deviceConfig) {
    this.platform = platform;
    this.log = platform.log;
    this.stateStore = platform.stateStore;
    this.accessory = accessory;
    this.currentState = null;
    this.timers = new Set();
    this.type = deviceConfig.type;

    this.updateConfig(deviceConfig);
  }

  updateConfig(deviceConfig) {
    this.stop();
    this.config = deviceConfig;
    this.type = deviceConfig.type;
    this.id = deviceConfig.id;
    this.name = deviceConfig.name;
    this.setupServices();
    this.applyInitialState();
    this.start();
  }

  setupServices() {
    this.informationService = this.accessory.getService(Service.AccessoryInformation) ||
      this.accessory.addService(Service.AccessoryInformation);
    this.informationService
      .setCharacteristic(Characteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(Characteristic.Model, formatDeviceType(this.type))
      .setCharacteristic(Characteristic.Name, this.name)
      .setCharacteristic(Characteristic.SerialNumber, createSerialNumber(this.id));

    this.switchService = this.accessory.getService(Service.Switch) ||
      this.accessory.addService(Service.Switch, this.name);
    this.switchService.setCharacteristic(Characteristic.Name, this.name);

    const onCharacteristic = this.switchService.getCharacteristic(Characteristic.On);
    onCharacteristic.removeAllListeners('get');
    onCharacteristic.removeAllListeners('set');
    onCharacteristic.on('get', this.handleGetOn.bind(this));
    onCharacteristic.on('set', this.handleSetOn.bind(this));
  }

  applyInitialState() {
    this.publishState(false, 'config load', true);
  }

  start() {
  }

  stop() {
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers.clear();
  }

  setTimer(callback, delayMs) {
    const timer = setManagedTimeout(() => {
      this.timers.delete(timer);
      callback();
    }, delayMs);

    this.timers.add(timer);
    return timer;
  }

  handleGetOn(callback) {
    if (typeof callback === 'function') {
      callback(null, Boolean(this.currentState));
    }
  }

  handleSetOn(value, callback) {
    this.publishState(Boolean(value), 'manual update', true);

    if (typeof callback === 'function') {
      callback(null);
    }
  }

  publishState(state, reason, force) {
    const nextState = Boolean(state);
    const didChange = this.currentState !== nextState;

    this.currentState = nextState;

    if (force || didChange) {
      this.switchService.updateCharacteristic(Characteristic.On, nextState);
    }

    if (didChange) {
      writeInfo(this.log, `${this.name} turned ${formatState(nextState)} from ${reason}.`);
    }

    return didChange;
  }
}

class ScheduledSwitchDevice extends BaseSwitchDevice {
  updateConfig(deviceConfig) {
    this.manualOverrideActive = false;
    this.defaultState = Boolean(deviceConfig.defaultState);
    this.enableIntervalCheck = Boolean(deviceConfig.enableIntervalCheck);
    this.intervalMinutes = normalizeIntervalMinutes(deviceConfig.intervalMinutes);
    this.entries = schedule.normalizeSchedule(deviceConfig.entries, this.log, deviceConfig.name);
    super.updateConfig(deviceConfig);
  }

  applyInitialState() {
    this.manualOverrideActive = false;
    this.publishState(this.evaluateScheduledState(new Date()), 'config load', true);
  }

  start() {
    this.scheduleNextBoundaryTrigger();

    if (this.enableIntervalCheck) {
      this.scheduleNextScheduleCheck();
    }
  }

  handleSetOn(value, callback) {
    this.manualOverrideActive = true;
    this.publishState(Boolean(value), 'manual update', true);
    writeInfo(this.log, `${this.name} is manually ${formatState(value)} until the next schedule trigger${this.enableIntervalCheck ? ' or interval check' : ''}.`);

    if (typeof callback === 'function') {
      callback(null);
    }
  }

  scheduleNextBoundaryTrigger() {
    const nextBoundary = schedule.findNextBoundaryAfter(this.entries, new Date());

    if (!nextBoundary) {
      return;
    }

    this.setTimer(() => {
      this.applyScheduledState('schedule trigger');
      this.scheduleNextBoundaryTrigger();
    }, calculateDelayTo(nextBoundary));
  }

  scheduleNextScheduleCheck() {
    const nextCheck = schedule.findNextIntervalBoundaryAfter(new Date(), this.intervalMinutes);

    if (!nextCheck) {
      return;
    }

    this.setTimer(() => {
      this.applyScheduledState('interval check');
      this.scheduleNextScheduleCheck();
    }, calculateDelayTo(nextCheck));
  }

  applyScheduledState(reason) {
    const scheduledState = this.evaluateScheduledState(new Date());
    const wasManual = this.manualOverrideActive;

    this.manualOverrideActive = false;
    this.publishState(scheduledState, reason, false);

    if (wasManual) {
      writeInfo(this.log, `${this.name} returned to scheduled ${formatState(scheduledState)} from ${reason}.`);
    }

    return scheduledState;
  }

  evaluateScheduledState(now) {
    const isInsideRange = schedule.isActiveAt(this.entries, now);

    return isInsideRange ? !this.defaultState : this.defaultState;
  }
}

class PlainSwitchDevice extends BaseSwitchDevice {
  applyInitialState() {
    const state = this.stateStore.get(this.id, this.config.state);
    this.publishState(state, 'config load', true);
  }

  handleSetOn(value, callback) {
    const nextState = Boolean(value);

    this.publishState(nextState, 'manual update', true);
    this.stateStore.set(this.id, nextState);

    if (typeof callback === 'function') {
      callback(null);
    }
  }
}

class IntervalSwitchDevice extends PlainSwitchDevice {
  updateConfig(deviceConfig) {
    this.runtimeAnchor = new Date();
    this.intervalMinutes = normalizePositiveMinutes(deviceConfig.intervalMinutes, DEFAULT_INTERVAL_MINUTES);
    this.startTimeMinutes = deviceConfig.startTimeMinutes;
    super.updateConfig(deviceConfig);
  }

  start() {
    this.scheduleNextFlip();
  }

  scheduleNextFlip() {
    const nextFlip = this.findNextFlipAfter(new Date());

    if (!nextFlip) {
      return;
    }

    this.setTimer(() => {
      const nextState = !Boolean(this.currentState);
      this.publishState(nextState, 'interval flip', false);
      this.stateStore.set(this.id, nextState);
      this.scheduleNextFlip();
    }, calculateDelayTo(nextFlip));
  }

  findNextFlipAfter(now) {
    const intervalMs = this.intervalMinutes * MILLISECONDS_PER_MINUTE;
    const anchor = typeof this.startTimeMinutes === 'number'
      ? createDailyAnchor(now, this.startTimeMinutes)
      : this.runtimeAnchor;

    if (now.getTime() < anchor.getTime()) {
      return anchor;
    }

    const elapsedMs = now.getTime() - anchor.getTime();
    const steps = Math.floor(elapsedMs / intervalMs) + 1;

    return new Date(anchor.getTime() + steps * intervalMs);
  }
}

class TimerSwitchDevice extends BaseSwitchDevice {
  updateConfig(deviceConfig) {
    this.defaultState = Boolean(deviceConfig.defaultState);
    this.durationMinutes = normalizePositiveMinutes(deviceConfig.durationMinutes, DEFAULT_TIMER_MINUTES);
    super.updateConfig(deviceConfig);
  }

  applyInitialState() {
    this.publishState(this.defaultState, 'config load', true);
  }

  handleSetOn(value, callback) {
    const nextState = Boolean(value);
    const didChange = this.publishState(nextState, 'manual update', true);

    if (nextState === this.defaultState) {
      this.stop();
    } else if (didChange) {
      this.startReturnTimer();
    }

    if (typeof callback === 'function') {
      callback(null);
    }
  }

  startReturnTimer() {
    this.stop();
    this.setTimer(() => {
      this.publishState(this.defaultState, 'timer elapsed', false);
    }, this.durationMinutes * MILLISECONDS_PER_MINUTE);
  }
}

class StateStore {
  constructor(api, log) {
    this.log = log;
    this.filePath = createStateStorePath(api);
    this.states = this.load();
  }

  get(id, fallback) {
    if (Object.prototype.hasOwnProperty.call(this.states, id) && typeof this.states[id] === 'boolean') {
      return this.states[id];
    }

    return Boolean(fallback);
  }

  set(id, state) {
    this.states[id] = Boolean(state);
    this.save();
  }

  /**
   * <summary>
   * Preserves a stored plain or interval switch state when the same cached
   * accessory receives a newly normalized stable ID. Existing target state has
   * preference. The source state remains available so no unrelated device that
   * still references the previous key loses data.
   * </summary>
   * @param {string} sourceId Previous supported identifier candidate.
   * @param {string} targetId Current authoritative normalized identifier.
   * @returns {boolean} True when state was copied and persisted under the new ID.
   */
  preserveStateForIdChange(sourceId, targetId) {
    if (!sourceId || !targetId || sourceId === targetId ||
        Object.prototype.hasOwnProperty.call(this.states, targetId) ||
        typeof this.states[sourceId] !== 'boolean') {
      return false;
    }

    this.states[targetId] = this.states[sourceId];
    this.save();
    return true;
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) {
        return {};
      }

      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));

      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch (error) {
      writeWarning(this.log, `Could not load ${PLATFORM_NAME} state store. ${error.message}`);
    }

    return {};
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.states, null, 2));
    } catch (error) {
      writeWarning(this.log, `Could not save ${PLATFORM_NAME} state store. ${error.message}`);
    }
  }
}

function createDeviceRuntime(platform, accessory, deviceConfig) {
  switch (deviceConfig.type) {
    case TYPE_SCHEDULED:
      return new ScheduledSwitchDevice(platform, accessory, deviceConfig);
    case TYPE_SWITCH:
      return new PlainSwitchDevice(platform, accessory, deviceConfig);
    case TYPE_INTERVAL:
      return new IntervalSwitchDevice(platform, accessory, deviceConfig);
    case TYPE_TIMER:
      return new TimerSwitchDevice(platform, accessory, deviceConfig);
    default:
      throw new Error(`Unsupported ${PLATFORM_NAME} device type '${deviceConfig.type}'.`);
  }
}

/**
 * <summary>
 * Captures the identifier each configured device would have used under the
 * previous normalization contract before stable IDs are normalized in memory.
 * These transient candidates let reconciliation retain an existing cached
 * accessory when an update changes ID normalization instead of recreating it.
 * </summary>
 * @param {object} config Runtime platform configuration before ID preparation.
 * @returns {WeakMap<object, string>} Previous identifier candidate per raw device object.
 */
function collectLegacyIdentityCandidates(config) {
  const candidates = new WeakMap();

  if (!config || typeof config !== 'object') {
    return candidates;
  }

  DEVICE_COLLECTIONS.forEach((collection) => {
    const devices = config[collection.key];

    if (!Array.isArray(devices)) {
      return;
    }

    devices.forEach((device, index) => {
      if (!device || typeof device !== 'object' || Array.isArray(device)) {
        return;
      }

      const name = normalizeName(device.name, collection.defaultName, index);
      const source = typeof device.id === 'string' && device.id.trim() ? device.id : name;

      candidates.set(device, createLegacyIdentifier(source, collection.fallbackId));
    });
  });

  return candidates;
}

/**
 * <summary>
 * Normalizes every typed device array into the runtime configuration used for
 * accessory reconciliation. Previous identity candidates remain transient and
 * are attached only to runtime records so normalization updates can reuse cache.
 * </summary>
 * @param {object} config Runtime platform configuration.
 * @param {Function|object} log Homebridge logger for config warnings.
 * @param {WeakMap<object, string>} legacyIdentityCandidates Previous IDs by raw device object.
 * @returns {Array<object>} Valid normalized devices with duplicate IDs removed.
 */
function normalizePlatformConfig(config, log, legacyIdentityCandidates) {
  if (!config || typeof config !== 'object') {
    return [];
  }

  const rawDevices = [];

  DEVICE_COLLECTIONS.forEach((collection) => {
    const rawCollection = config[collection.key];

    if (rawCollection === undefined || rawCollection === null) {
      return;
    }

    if (!Array.isArray(rawCollection)) {
      writeWarning(log, `${PLATFORM_NAME} ${collection.key} must be an array and was skipped.`);
      return;
    }

    rawCollection.forEach((rawDevice, index) => {
      const deviceConfig = normalizeDeviceConfig(rawDevice, collection, index, log, legacyIdentityCandidates);

      if (deviceConfig) {
        rawDevices.push(deviceConfig);
      }
    });
  });

  return removeDuplicateIds(rawDevices, log);
}

/**
 * <summary>
 * Normalizes one raw typed switch object into the runtime shape used by its
 * device controller and accessory reconciliation. The authoritative stable ID,
 * current generated fallback, and previous identity candidate are kept distinct.
 * </summary>
 * @param {object} rawDevice Raw device configuration object.
 * @param {object} collection Typed device collection definition.
 * @param {number} index Zero-based position in the typed collection.
 * @param {Function|object} log Homebridge logger for validation warnings.
 * @param {WeakMap<object, string>} legacyIdentityCandidates Previous IDs by raw device object.
 * @returns {object|null} Normalized runtime device or null when the entry is invalid.
 */
function normalizeDeviceConfig(rawDevice, collection, index, log, legacyIdentityCandidates) {
  if (!rawDevice || typeof rawDevice !== 'object') {
    writeWarning(log, `${PLATFORM_NAME} ${collection.key} item ${index + 1} must be an object and was skipped.`);
    return null;
  }

  const name = normalizeName(rawDevice.name, collection.defaultName, index);
  const generatedId = createGeneratedIdentifier(PLUGIN_NAME, name, collection.fallbackId);
  const config = {
    type: collection.type,
    fallbackId: collection.fallbackId,
    generatedId,
    id: normalizeIdentifier(rawDevice.id) || generatedId,
    legacyId: legacyIdentityCandidates.get(rawDevice) || createLegacyIdentifier(name, collection.fallbackId),
    name
  };

  if (collection.type === TYPE_SCHEDULED) {
    config.defaultState = Boolean(rawDevice.defaultState);
    config.entries = Array.isArray(rawDevice.entries) ? rawDevice.entries : [];
    config.enableIntervalCheck = Boolean(rawDevice.enableIntervalCheck);
    config.intervalMinutes = normalizeIntervalMinutes(rawDevice.intervalMinutes);
    return config;
  }

  if (collection.type === TYPE_SWITCH) {
    config.state = Boolean(rawDevice.state);
    return config;
  }

  if (collection.type === TYPE_INTERVAL) {
    config.state = Boolean(rawDevice.state);
    config.intervalMinutes = normalizePositiveMinutes(rawDevice.intervalMinutes, DEFAULT_INTERVAL_MINUTES);
    config.startTimeMinutes = normalizeOptionalStartTime(rawDevice.startTime, log, name);
    return config;
  }

  if (collection.type === TYPE_TIMER) {
    config.defaultState = Boolean(rawDevice.defaultState);
    config.durationMinutes = normalizePositiveMinutes(rawDevice.durationMinutes, DEFAULT_TIMER_MINUTES);
    return config;
  }

  return null;
}

/**
 * <summary>
 * Removes duplicate configured identifiers after device normalization. Explicit
 * IDs remain authoritative, so a later duplicate is skipped with a warning
 * instead of being silently changed into a different accessory identity.
 * </summary>
 * @param {Array<object>} devices Normalized device configurations.
 * @param {Function|object} log Homebridge logger used for duplicate warnings.
 * @returns {Array<object>} Device configurations with unique IDs.
 */
function removeDuplicateIds(devices, log) {
  const usedIds = new Set();

  return devices.filter((device) => {
    if (usedIds.has(device.id)) {
      writeWarning(log, `${PLATFORM_NAME} device '${device.name}' uses duplicate id '${device.id}' and was skipped.`);
      return false;
    }

    usedIds.add(device.id);
    return true;
  });
}

/**
 * <summary>
 * Reproduces the exact name-based identifier format used before the shared
 * plugin-prefixed ID contract. It is used only to locate a cached accessory
 * during migration and never becomes the new automatically generated config ID.
 * </summary>
 * @param {*} name Legacy device name source.
 * @param {string} fallbackId Legacy collection fallback identifier.
 * @returns {string} Legacy normalized identifier used by earlier accessory UUIDs.
 */
function createLegacyIdentifier(name, fallbackId) {
  const normalized = String(name || '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/(^-|-$)/g, '');

  return normalized || fallbackId || 'switch';
}

function normalizeName(value, defaultName, index) {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  return `${defaultName} ${index + 1}`;
}

function normalizeIntervalMinutes(value) {
  const parsedValue = Number(value);

  if (!Number.isFinite(parsedValue)) {
    return DEFAULT_INTERVAL_MINUTES;
  }

  return Math.min(Math.max(Math.floor(parsedValue), MIN_MINUTES), MAX_INTERVAL_MINUTES);
}

function normalizePositiveMinutes(value, fallback) {
  const parsedValue = Number(value);

  if (!Number.isFinite(parsedValue)) {
    return fallback;
  }

  return Math.max(Math.floor(parsedValue), MIN_MINUTES);
}

function normalizeOptionalStartTime(value, log, name) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const minutes = schedule.parseTimeToMinutes(value);

  if (minutes === null) {
    writeWarning(log, `${PLATFORM_NAME} interval switch '${name}' has an invalid startTime and will use activation time.`);
    return null;
  }

  return minutes;
}

function calculateDelayTo(targetDate) {
  return Math.max(250, targetDate.getTime() - Date.now() + 250);
}

function setManagedTimeout(callback, delayMs) {
  const timer = setTimeout(callback, Math.max(250, delayMs));

  if (timer && typeof timer.unref === 'function') {
    timer.unref();
  }

  return timer;
}

function createDailyAnchor(date, minuteOfDay) {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    Math.floor(minuteOfDay / 60),
    minuteOfDay % 60,
    0,
    0
  );
}

function createStateStorePath(api) {
  const user = api && api.user;
  const basePath = user && typeof user.storagePath === 'function'
    ? user.storagePath()
    : process.cwd();

  return path.join(basePath, STATE_FILE_NAME);
}

function createSerialNumber(id) {
  return `jsg-switches-${id || 'switch'}`;
}

function formatDeviceType(type) {
  switch (type) {
    case TYPE_SCHEDULED:
      return 'Scheduled Switch';
    case TYPE_SWITCH:
      return 'Switch';
    case TYPE_INTERVAL:
      return 'Interval Switch';
    case TYPE_TIMER:
      return 'Timer Switch';
    default:
      return 'Switch';
  }
}

function formatState(value) {
  return Boolean(value) ? 'on' : 'off';
}

function writeInfo(log, message) {
  if (log && typeof log.info === 'function') {
    log.info(message);
    return;
  }

  if (typeof log === 'function') {
    log(message);
  }
}

function writeWarning(log, message) {
  if (log && typeof log.warn === 'function') {
    log.warn(message);
    return;
  }

  if (typeof log === 'function') {
    log(message);
  }
}