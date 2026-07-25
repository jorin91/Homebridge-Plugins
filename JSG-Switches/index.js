'use strict';

const fs = require('fs');
const path = require('path');
const {
  createAccessoryIdentity,
  createLegacyGeneratedIdentifier,
  ensureStableDeviceIds,
  matchesAccessoryIdentityContext,
  normalizeIdentityPath,
  normalizeLegacyFlatIdentifier,
  readAccessoryIdentityContext,
  writeAccessoryIdentityContext
} = require('./lib/config-identity');
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

  /**
   * <summary>
   * Resolves and persists canonical base IDs before reconciling every configured
   * switch against Homebridge cache. Valid devices are updated or created in
   * place. Stale cleanup runs only after all identities reconcile without error.
   * </summary>
   */
  syncConfiguredDevices() {
    const legacyIdentityCandidates = collectLegacyIdentityCandidates(this.config);
    const identityResolution = ensureStableDeviceIds({
      config: this.config,
      api: this.api,
      log: this.log,
      pluginName: PLUGIN_NAME,
      platformName: PLATFORM_NAME,
      collections: DEVICE_COLLECTIONS
    });

    if (!identityResolution.persistenceSucceeded) {
      writeWarning(this.log, `${PLATFORM_NAME} skipped accessory reconciliation because stable IDs could not be persisted before use.`);
      return;
    }

    const normalizedConfig = normalizePlatformConfig(
      this.config,
      this.log,
      legacyIdentityCandidates,
      identityResolution.invalidDevices
    );
    const configuredDevices = normalizedConfig.devices;
    const configuredIds = new Set(configuredDevices.map((device) => device.id));
    const configuredUuids = new Set();
    let hasReconciliationErrors = identityResolution.hasErrors || normalizedConfig.hasErrors;

    configuredDevices.forEach((deviceConfig) => {
      const targetUuid = this.api.hap.uuid.generate(deviceConfig.identity.seed);
      let accessory = this.findCachedAccessory(deviceConfig, targetUuid, configuredIds, configuredUuids);
      const matchedCachedAccessory = Boolean(accessory);

      if (!accessory && this.cachedAccessories.has(targetUuid)) {
        hasReconciliationErrors = true;
        writeWarning(this.log, `${PLATFORM_NAME} device '${deviceConfig.name}' uses an identity whose UUID is retained by another configured accessory and was skipped.`);
        return;
      }

      if (!accessory) {
        accessory = new this.api.platformAccessory(deviceConfig.name, targetUuid);
        this.cachedAccessories.set(targetUuid, accessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        writeInfo(this.log, `Created ${formatDeviceType(deviceConfig.type)} '${deviceConfig.name}'.`);
      }

      const previousIdentityIds = collectCachedIdentityBaseIds(accessory, deviceConfig.identity.namespace);

      configuredUuids.add(accessory.UUID);
      writeAccessoryIdentityContext(accessory, deviceConfig.identity);
      accessory.context.deviceId = deviceConfig.id;
      accessory.context.deviceType = deviceConfig.type;
      accessory.context.deviceConfig = deviceConfig;

      if (typeof accessory.updateDisplayName === 'function') {
        accessory.updateDisplayName(deviceConfig.name);
      } else {
        accessory.displayName = deviceConfig.name;
      }

      if (matchedCachedAccessory && (deviceConfig.type === TYPE_SWITCH || deviceConfig.type === TYPE_INTERVAL)) {
        this.stateStore.preserveStateForIdChange(
          previousIdentityIds.concat(deviceConfig.legacyBaseIds),
          deviceConfig.id
        );
      }

      this.startOrUpdateDevice(accessory, deviceConfig);

      if (typeof this.api.updatePlatformAccessories === 'function') {
        this.api.updatePlatformAccessories([accessory]);
      }
    });

    if (hasReconciliationErrors) {
      writeWarning(this.log, `${PLATFORM_NAME} kept unmatched cached accessories because one or more configured identities were invalid or ambiguous.`);
      return;
    }

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
   * Finds the cached accessory for one current singleton identity. Exact current
   * structured context has priority, followed by the current UUID. Supported
   * structured context, legacy deviceId values, and legacy UUID seeds are lookup
   * candidates only. A retained accessory always keeps its actual Homebridge UUID.
   * </summary>
   * @param {object} deviceConfig Normalized device configuration and identity.
   * @param {string} targetUuid UUID generated from the current complete seed.
   * @param {Set<string>} configuredIds Current authoritative base IDs.
   * @param {Set<string>} claimedUuids Cached UUIDs already assigned this cycle.
   * @returns {object|null} Retained cached accessory or null when creation is required.
   */
  findCachedAccessory(deviceConfig, targetUuid, configuredIds, claimedUuids) {
    const isUnclaimed = (accessory) => accessory && !claimedUuids.has(accessory.UUID);
    const isAvailableFallback = (accessory) => {
      if (!isUnclaimed(accessory)) {
        return false;
      }

      const reservedId = findReservedCachedBaseId(
        accessory,
        deviceConfig.identity.namespace,
        configuredIds
      );

      return !reservedId || reservedId === deviceConfig.id;
    };
    const exactContextMatch = Array.from(this.cachedAccessories.values()).find((accessory) =>
      isUnclaimed(accessory) && matchesAccessoryIdentityContext(accessory, deviceConfig.identity));

    if (exactContextMatch) {
      return exactContextMatch;
    }

    const directMatch = this.cachedAccessories.get(targetUuid);

    if (isAvailableFallback(directMatch)) {
      return directMatch;
    }

    const supportedContextIds = new Set([deviceConfig.id, ...deviceConfig.legacyBaseIds]);
    const legacyStructuredMatch = Array.from(this.cachedAccessories.values()).find((accessory) => {
      if (!isAvailableFallback(accessory)) {
        return false;
      }

      const storedIdentity = readAccessoryIdentityContext(accessory);
      const storedBaseId = storedIdentity && normalizeIdentityPath(storedIdentity.baseId);

      return Boolean(
        storedIdentity &&
        storedIdentity.namespace === deviceConfig.identity.namespace &&
        storedIdentity.type === null &&
        Array.isArray(storedIdentity.parts) &&
        storedIdentity.parts.length === 0 &&
        storedBaseId &&
        supportedContextIds.has(storedBaseId)
      );
    });

    if (legacyStructuredMatch) {
      return legacyStructuredMatch;
    }

    const legacyContextMatch = Array.from(this.cachedAccessories.values()).find((accessory) => {
      if (!isAvailableFallback(accessory)) {
        return false;
      }

      return collectLegacyDeviceContextIds(accessory).some((candidate) =>
        supportedContextIds.has(candidate));
    });

    if (legacyContextMatch) {
      return legacyContextMatch;
    }

    for (const legacySeed of deviceConfig.legacySeeds) {
      const legacyUuid = this.api.hap.uuid.generate(legacySeed);
      const legacyUuidMatch = this.cachedAccessories.get(legacyUuid);

      if (isAvailableFallback(legacyUuidMatch)) {
        return legacyUuidMatch;
      }
    }

    return null;
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
   * Preserves stored plain or interval switch state when the same cached
   * accessory is retained under a current base ID. Current target state has
   * preference. The first supported source key with a boolean value is copied,
   * while every source key remains intact for any unrelated legacy reference.
   * </summary>
   * @param {Array<string>} sourceIds Previous supported base ID candidates.
   * @param {string} targetId Current authoritative canonical base ID.
   * @returns {boolean} True when state was copied and persisted under the target ID.
   */
  preserveStateForIdChange(sourceIds, targetId) {
    if (!Array.isArray(sourceIds) || !targetId ||
        Object.prototype.hasOwnProperty.call(this.states, targetId)) {
      return false;
    }

    const sourceId = sourceIds.find((candidate) =>
      candidate && candidate !== targetId && typeof this.states[candidate] === 'boolean');

    if (!sourceId) {
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
 * Captures every supported previous base-ID candidate before config writeback.
 * Version 0.1.6 plugin-prefixed generation, its flat normalization, and the
 * original name-only UUID form remain lookup candidates only.
 * </summary>
 * @param {object} config Runtime platform config before ID preparation.
 * @returns {WeakMap<object, Array<string>>} Legacy base IDs per raw device object.
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

      const values = new Set();
      const name = normalizeName(device.name, collection.defaultName, index);
      const hasConfiguredId = Object.prototype.hasOwnProperty.call(device, 'id');

      if (hasConfiguredId) {
        addIdentityCandidate(values, normalizeLegacyFlatIdentifier(device.id));
        addIdentityCandidate(values, createLegacyIdentifier(device.id, collection.fallbackId));
      } else {
        addIdentityCandidate(
          values,
          createLegacyGeneratedIdentifier(PLUGIN_NAME, name, collection.fallbackId)
        );
      }

      addIdentityCandidate(values, normalizeLegacyFlatIdentifier(name));
      addIdentityCandidate(values, createLegacyIdentifier(name, collection.fallbackId));
      candidates.set(device, Array.from(values));
    });
  });

  return candidates;
}

/**
 * <summary>
 * Normalizes every typed device array into current runtime records. Invalid
 * identity entries are skipped, while the returned error flag tells the platform
 * to retain unmatched cache entries instead of performing destructive cleanup.
 * </summary>
 * @param {object} config Runtime platform configuration.
 * @param {Function|object} log Homebridge logger for validation warnings.
 * @param {WeakMap<object, Array<string>>} legacyIdentityCandidates Previous IDs.
 * @param {WeakSet<object>} invalidDevices Raw devices rejected by ID resolution.
 * @returns {object} Valid devices and whether any configuration errors occurred.
 */
function normalizePlatformConfig(config, log, legacyIdentityCandidates, invalidDevices) {
  if (!config || typeof config !== 'object') {
    return { devices: [], hasErrors: true };
  }

  const rawDevices = [];
  let hasErrors = false;

  DEVICE_COLLECTIONS.forEach((collection) => {
    const rawCollection = config[collection.key];

    if (rawCollection === undefined || rawCollection === null) {
      return;
    }

    if (!Array.isArray(rawCollection)) {
      hasErrors = true;
      writeWarning(log, `${PLATFORM_NAME} ${collection.key} must be an array and was skipped.`);
      return;
    }

    rawCollection.forEach((rawDevice, index) => {
      if (!rawDevice || typeof rawDevice !== 'object' || Array.isArray(rawDevice)) {
        hasErrors = true;
        writeWarning(log, `${PLATFORM_NAME} ${collection.key} item ${index + 1} must be an object and was skipped.`);
        return;
      }

      if (invalidDevices && invalidDevices.has(rawDevice)) {
        hasErrors = true;
        return;
      }

      const deviceConfig = normalizeDeviceConfig(
        rawDevice,
        collection,
        index,
        log,
        legacyIdentityCandidates
      );

      if (!deviceConfig) {
        hasErrors = true;
        return;
      }

      rawDevices.push(deviceConfig);
    });
  });

  const duplicateResolution = removeDuplicateIds(rawDevices, log);

  return {
    devices: duplicateResolution.devices,
    hasErrors: hasErrors || duplicateResolution.hasErrors
  };
}

/**
 * <summary>
 * Converts one typed switch object into the current singleton identity and
 * behavior shape. Its configured ID owns only the base path. Namespace is added
 * by code when the complete seed is assembled.
 * </summary>
 * @param {object} rawDevice Raw device configuration object.
 * @param {object} collection Typed device collection definition.
 * @param {number} index Zero-based position in the typed collection.
 * @param {Function|object} log Homebridge logger for validation warnings.
 * @param {WeakMap<object, Array<string>>} legacyIdentityCandidates Previous IDs.
 * @returns {object|null} Normalized runtime device or null when invalid.
 */
function normalizeDeviceConfig(rawDevice, collection, index, log, legacyIdentityCandidates) {
  const name = normalizeName(rawDevice.name, collection.defaultName, index);
  const id = normalizeIdentityPath(rawDevice.id);
  const identity = createAccessoryIdentity(PLUGIN_NAME, id);

  if (!id || !identity) {
    writeWarning(log, `${PLATFORM_NAME} ${collection.key} item ${index + 1} has no valid current identity and was skipped.`);
    return null;
  }

  const legacyBaseIds = Array.from(new Set(legacyIdentityCandidates.get(rawDevice) || []))
    .filter((candidate) => candidate && candidate !== id);
  const legacySeeds = Array.from(new Set(legacyBaseIds.map((candidate) =>
    `${PLUGIN_NAME}:${candidate}`)));
  const config = {
    type: collection.type,
    fallbackId: collection.fallbackId,
    id,
    identity,
    legacyBaseIds,
    legacySeeds,
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
 * Performs a final defensive duplicate check across all four typed arrays. The
 * ID preparation stage already reserves this combined domain, but this guard
 * prevents ambiguous reconciliation if a future caller bypasses that stage.
 * </summary>
 * @param {Array<object>} devices Normalized device configurations.
 * @param {Function|object} log Homebridge logger used for duplicate warnings.
 * @returns {object} Unique devices and whether duplicates were rejected.
 */
function removeDuplicateIds(devices, log) {
  const usedIds = new Set();
  const uniqueDevices = [];
  let hasErrors = false;

  devices.forEach((device) => {
    if (usedIds.has(device.id)) {
      hasErrors = true;
      writeWarning(log, `${PLATFORM_NAME} device '${device.name}' uses duplicate id '${device.id}' and was skipped.`);
      return;
    }

    usedIds.add(device.id);
    uniqueDevices.push(device);
  });

  return { devices: uniqueDevices, hasErrors };
}

/**
 * <summary>
 * Collects current structured and legacy deviceId base paths from one cached
 * accessory. These candidates support state retention and legacy reconciliation
 * without deriving identity from the live display name.
 * </summary>
 * @param {object} accessory Cached Homebridge accessory.
 * @param {string} namespace Current effective plugin namespace.
 * @returns {Array<string>} Unique supported cached base-ID candidates.
 */
function collectCachedIdentityBaseIds(accessory, namespace) {
  const candidates = new Set();
  const storedIdentity = readAccessoryIdentityContext(accessory);

  if (storedIdentity && storedIdentity.namespace === namespace) {
    addIdentityCandidate(candidates, normalizeIdentityPath(storedIdentity.baseId));
    addIdentityCandidate(candidates, normalizeLegacyFlatIdentifier(storedIdentity.baseId));
  }

  collectLegacyDeviceContextIds(accessory).forEach((candidate) =>
    addIdentityCandidate(candidates, candidate));

  return Array.from(candidates);
}

/**
 * <summary>
 * Reads the deviceId context field used by earlier plugin releases through both
 * the current path formatter and the version 0.1.6 flat formatter.
 * </summary>
 * @param {object} accessory Cached Homebridge accessory.
 * @returns {Array<string>} Canonical current and previous deviceId candidates.
 */
function collectLegacyDeviceContextIds(accessory) {
  const candidates = new Set();
  const deviceId = accessory && accessory.context && accessory.context.deviceId;

  addIdentityCandidate(candidates, normalizeIdentityPath(deviceId));
  addIdentityCandidate(candidates, normalizeLegacyFlatIdentifier(deviceId));

  return Array.from(candidates);
}

/**
 * <summary>
 * Finds whether cached context reserves an accessory for another configured base
 * ID. Structured current context has priority over the older deviceId field.
 * This prevents one legacy fallback from stealing another configured accessory.
 * </summary>
 * @param {object} accessory Cached Homebridge accessory.
 * @param {string} namespace Current effective plugin namespace.
 * @param {Set<string>} configuredIds Current authoritative base IDs.
 * @returns {string|null} Reserved configured base ID or null when unreserved.
 */
function findReservedCachedBaseId(accessory, namespace, configuredIds) {
  const storedIdentity = readAccessoryIdentityContext(accessory);

  if (storedIdentity && storedIdentity.namespace === namespace) {
    const structuredBaseId = normalizeIdentityPath(storedIdentity.baseId);

    if (structuredBaseId && configuredIds.has(structuredBaseId)) {
      return structuredBaseId;
    }
  }

  return collectLegacyDeviceContextIds(accessory).find((candidate) =>
    configuredIds.has(candidate)) || null;
}

/**
 * <summary>
 * Adds a usable string identity candidate to a set. Empty and non-string values
 * are ignored so legacy lookup lists remain deterministic and safe.
 * </summary>
 * @param {Set<string>} candidates Candidate collection being assembled.
 * @param {*} value Potential identity candidate.
 */
function addIdentityCandidate(candidates, value) {
  if (typeof value === 'string' && value) {
    candidates.add(value);
  }
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