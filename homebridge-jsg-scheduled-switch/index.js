'use strict';

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

const PLUGIN_NAME = 'homebridge-jsg-scheduled-switch';
const PLATFORM_NAME = 'JsgScheduledSwitch';
const DEFAULT_DEVICE_NAME = 'Scheduled Switch';
const DEFAULT_INTERVAL_MINUTES = 15;
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 1440;
const DEVICE_COLLECTIONS = Object.freeze([
  {
    key: 'devices',
    defaultName: DEFAULT_DEVICE_NAME,
    fallbackId: 'scheduled-switch',
    missingNameIdPrefix: 'device'
  }
]);

let Service;
let Characteristic;

/**
 * <summary>
 * Registers the scheduled switch platform with Homebridge. A platform is used
 * instead of a single accessory so one config block can own multiple virtual
 * switches, each with its own name, schedule entries, and optional periodic
 * schedule check behavior.
 * </summary>
 * @param {object} homebridge Homebridge runtime object provided during plugin load.
 */
module.exports = function registerScheduledSwitchPlatform(homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;

  homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, ScheduledSwitchPlatform);
};

/**
 * <summary>
 * Homebridge dynamic platform that reconciles the configured `devices` array
 * with Homebridge cached accessories. It creates missing virtual switches,
 * updates configured switches, and removes cached switches whose device config
 * no longer exists after Homebridge restarts or reloads the plugin config.
 * </summary>
 */
class ScheduledSwitchPlatform {
  /**
   * <summary>
   * Stores platform configuration, prepares cached accessory tracking, and hooks
   * Homebridge lifecycle events. Actual device reconciliation is delayed until
   * `didFinishLaunching` so all cached accessories have been supplied first.
   * </summary>
   * @param {Function|object} log Homebridge logger for this platform instance.
   * @param {object} config Platform config block from Homebridge.
   * @param {object} api Homebridge API object for dynamic platform operations.
   */
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.cachedAccessories = new Map();
    this.deviceRuntimes = new Map();

    if (this.api && typeof this.api.on === 'function') {
      this.api.on('didFinishLaunching', this.syncConfiguredDevices.bind(this));
      this.api.on('shutdown', this.shutdown.bind(this));
    }
  }

  /**
   * <summary>
   * Receives cached accessories from Homebridge before launch completes. The
   * platform keeps them in a UUID map so configured devices can be matched to
   * existing Homebridge accessories rather than being recreated unnecessarily.
   * </summary>
   * @param {object} accessory Cached Homebridge platform accessory.
   */
  configureAccessory(accessory) {
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  /**
   * <summary>
   * Resolves and persists canonical base IDs before reconciling the current
   * `devices` config against Homebridge cache. Valid devices are retained or
   * created in place. Stale cleanup runs only when every identity is valid and
   * unambiguous, preventing an editing error from removing accessories.
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

    const normalizedConfig = normalizeDeviceConfigs(
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

      if (!accessory && this.cachedAccessories.has(targetUuid)) {
        hasReconciliationErrors = true;
        writeWarning(this.log, `${PLATFORM_NAME} device '${deviceConfig.name}' uses an identity whose UUID is retained by another configured accessory and was skipped.`);
        return;
      }

      if (!accessory) {
        accessory = new this.api.platformAccessory(deviceConfig.name, targetUuid);
        this.cachedAccessories.set(targetUuid, accessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        writeInfo(this.log, `Created scheduled switch '${deviceConfig.name}'.`);
      }

      configuredUuids.add(accessory.UUID);
      writeAccessoryIdentityContext(accessory, deviceConfig.identity);
      accessory.context.deviceId = deviceConfig.id;
      accessory.context.deviceConfig = deviceConfig;

      if (typeof accessory.updateDisplayName === 'function') {
        accessory.updateDisplayName(deviceConfig.name);
      } else {
        accessory.displayName = deviceConfig.name;
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
        runtime.stopSchedulers();
        this.deviceRuntimes.delete(uuid);
      }

      this.cachedAccessories.delete(uuid);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      writeInfo(this.log, `Removed scheduled switch '${accessory.displayName || uuid}'.`);
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
  /**
   * <summary>
   * Creates or updates the runtime controller for one configured platform
   * accessory. Runtime controllers own Homebridge characteristic handlers and timer
   * scheduling, while the platform remains responsible for accessory lifecycle.
   * </summary>
   * @param {object} accessory Homebridge platform accessory.
   * @param {object} deviceConfig Normalized device configuration.
   */
  startOrUpdateDevice(accessory, deviceConfig) {
    const existingRuntime = this.deviceRuntimes.get(accessory.UUID);

    if (existingRuntime) {
      existingRuntime.updateConfig(deviceConfig);
      return;
    }

    this.deviceRuntimes.set(accessory.UUID, new ScheduledSwitchDevice(this, accessory, deviceConfig));
  }

  /**
   * <summary>
   * Stops all active device timers during Homebridge shutdown. This keeps the
   * platform lifecycle tidy and prevents timer callbacks from running while the
   * process is being torn down.
   * </summary>
   */
  shutdown() {
    this.deviceRuntimes.forEach((runtime) => runtime.stopSchedulers());
    this.deviceRuntimes.clear();
  }
}

/**
 * <summary>
 * Runtime controller for one configured virtual switch. It owns Homebridge switch
 * services, manual override state, schedule boundary timers, optional periodic
 * grid checks, and state publication for a single device config entry.
 * </summary>
 */
class ScheduledSwitchDevice {
  /**
   * <summary>
   * Creates a device runtime around an existing Homebridge platform accessory
   * and immediately applies the supplied config. The accessory object may be new
   * or restored from Homebridge cache.
   * </summary>
   * @param {ScheduledSwitchPlatform} platform Parent platform instance.
   * @param {object} accessory Homebridge platform accessory for this device.
   * @param {object} deviceConfig Normalized device configuration.
   */
  constructor(platform, accessory, deviceConfig) {
    this.platform = platform;
    this.log = platform.log;
    this.accessory = accessory;
    this.boundaryTimer = null;
    this.intervalTimer = null;
    this.currentState = null;
    this.manualOverrideActive = false;

    this.updateConfig(deviceConfig);
  }

  /**
   * <summary>
   * Applies new device configuration, rebuilds Homebridge service metadata, resets
   * schedule timers, and publishes the current scheduled state. This is used for
   * startup and for future config reload flows that reuse the same accessory.
   * </summary>
   * @param {object} deviceConfig Normalized device configuration.
   */
  updateConfig(deviceConfig) {
    this.stopSchedulers();

    this.config = deviceConfig;
    this.name = deviceConfig.name;
    this.inverseState = deviceConfig.inverseState;
    this.enableIntervalCheck = deviceConfig.enableIntervalCheck;
    this.intervalMinutes = deviceConfig.intervalMinutes;
    this.entries = schedule.normalizeSchedule(deviceConfig.entries, this.log, this.name);
    this.manualOverrideActive = false;

    this.setupServices();
    this.publishState(this.evaluateScheduledState(new Date()), 'config load', true);
    this.startSchedulers();
  }

  /**
   * <summary>
   * Creates or updates the Homebridge information and switch services for this
   * device. Characteristic listeners are replaced when config is reapplied so a
   * future reload cannot leave duplicate handlers attached to the same service.
   * </summary>
   */
  setupServices() {
    this.informationService = this.accessory.getService(Service.AccessoryInformation) ||
      this.accessory.addService(Service.AccessoryInformation);
    this.informationService
      .setCharacteristic(Characteristic.Manufacturer, 'JSG Homebridge')
      .setCharacteristic(Characteristic.Model, 'Scheduled Virtual Switch')
      .setCharacteristic(Characteristic.Name, this.name)
      .setCharacteristic(Characteristic.SerialNumber, createSerialNumber(this.config.id));

    this.switchService = this.accessory.getService(Service.Switch) ||
      this.accessory.addService(Service.Switch, this.name);
    this.switchService.setCharacteristic(Characteristic.Name, this.name);

    const onCharacteristic = this.switchService.getCharacteristic(Characteristic.On);
    onCharacteristic.removeAllListeners('get');
    onCharacteristic.removeAllListeners('set');
    onCharacteristic.on('get', this.handleGetOn.bind(this));
    onCharacteristic.on('set', this.handleSetOn.bind(this));
  }

  /**
   * <summary>
   * Handles switch reads by returning the currently published switch state. It
   * intentionally does not recalculate the schedule because manual overrides
   * must remain visible until the next schedule boundary or enabled interval
   * check takes control again.
   * </summary>
   * @param {Function} callback Homebridge callback receiving the current state.
   */
  handleGetOn(callback) {
    if (typeof callback === 'function') {
      callback(null, Boolean(this.currentState));
    }
  }

  /**
   * <summary>
   * Handles switch writes as temporary manual overrides. The requested state is
   * kept until the next configured start or end trigger, or until the next
   * enabled periodic interval check, at which point the schedule is evaluated
   * and republished.
   * </summary>
   * @param {boolean} value Requested switch state.
   * @param {Function} callback Homebridge callback used to acknowledge the write.
   */
  handleSetOn(value, callback) {
    this.manualOverrideActive = true;
    this.publishState(Boolean(value), 'manual update', true);
    writeInfo(this.log, `${this.name} is manually ${formatState(value)} until the next schedule trigger${this.enableIntervalCheck ? ' or interval check' : ''}.`);

    if (typeof callback === 'function') {
      callback(null);
    }
  }

  /**
   * <summary>
   * Starts every scheduler needed by this device. Schedule boundary triggers are
   * always used when entries exist, while periodic checks are added only when the
   * device config explicitly enables them.
   * </summary>
   */
  startSchedulers() {
    this.scheduleNextBoundaryTrigger();

    if (this.enableIntervalCheck) {
      this.scheduleNextIntervalCheck();
    }
  }

  /**
   * <summary>
   * Stops active boundary and interval timers. The method is safe to call during
   * config reloads, platform shutdown, and accessory removal.
   * </summary>
   */
  stopSchedulers() {
    if (this.boundaryTimer) {
      clearTimeout(this.boundaryTimer);
      this.boundaryTimer = null;
    }

    if (this.intervalTimer) {
      clearTimeout(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  /**
   * <summary>
   * Schedules the next configured start or end trigger. When the trigger fires,
   * any manual override is cleared and the switch state is recalculated from the
   * entries array, which is the behavior expected from a time clock.
   * </summary>
   */
  scheduleNextBoundaryTrigger() {
    const now = new Date();
    const nextBoundary = schedule.findNextBoundaryAfter(this.entries, now);

    if (!nextBoundary) {
      return;
    }

    this.boundaryTimer = setManagedTimeout(() => {
      this.boundaryTimer = null;
      this.applyScheduledState('schedule trigger');
      this.scheduleNextBoundaryTrigger();
    }, calculateDelayTo(nextBoundary));
  }

  /**
   * <summary>
   * Schedules the next optional periodic schedule check on a midnight-aligned
   * grid. For example, a 15-minute interval checks exactly at :00, :15, :30,
   * and :45 instead of every 15 minutes after Homebridge startup.
   * </summary>
   */
  scheduleNextIntervalCheck() {
    const nextCheck = schedule.findNextIntervalBoundaryAfter(new Date(), this.intervalMinutes);

    if (!nextCheck) {
      return;
    }

    this.intervalTimer = setManagedTimeout(() => {
      this.intervalTimer = null;
      this.applyScheduledState('interval check');
      this.scheduleNextIntervalCheck();
    }, calculateDelayTo(nextCheck));
  }

  /**
   * <summary>
   * Evaluates the configured schedule and republishes the scheduled state. This
   * clears any manual override because boundary triggers and enabled interval
   * checks are the moments where schedule control deliberately resumes.
   * </summary>
   * @param {string} reason Short diagnostic reason used when logging changes.
   * @returns {boolean} Scheduled switch state after evaluation.
   */
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

  /**
   * <summary>
   * Publishes a switch state to Homebridge and updates the runtime cache. It emits
   * characteristic changes only when the value changed unless a forced publish is
   * requested, keeping periodic checks quiet when no visible state changes.
   * </summary>
   * @param {boolean} state Switch state to publish.
   * @param {string} reason Short diagnostic reason used when logging changes.
   * @param {boolean} force True to publish even when the cached state matches.
   */
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
  }

  /**
   * <summary>
   * Calculates the current scheduled state for this device by delegating all
   * time-window semantics to the scheduler module. By default the switch is on inside a configured range and off outside every range. inverseState flips that result.
   * </summary>
   * @param {Date} now Local date and time to evaluate.
   * @returns {boolean} True when this virtual switch should be on after inversion.
   */
  evaluateScheduledState(now) {
    const isInsideRange = schedule.isActiveAt(this.entries, now);

    return this.inverseState ? !isInsideRange : isInsideRange;
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
  const devices = config && Array.isArray(config.devices) ? config.devices : [];

  devices.forEach((device, index) => {
    if (!device || typeof device !== 'object' || Array.isArray(device)) {
      return;
    }

    const values = new Set();
    const name = normalizeName(device.name, index);
    const hasConfiguredId = Object.prototype.hasOwnProperty.call(device, 'id');

    if (hasConfiguredId) {
      addIdentityCandidate(values, normalizeLegacyFlatIdentifier(device.id));
      addIdentityCandidate(values, createLegacyIdentifier(device.id));
    } else {
      addIdentityCandidate(
        values,
        createLegacyGeneratedIdentifier(PLUGIN_NAME, name, 'scheduled-switch')
      );
    }

    addIdentityCandidate(values, normalizeLegacyFlatIdentifier(name));
    addIdentityCandidate(values, createLegacyIdentifier(name));
    candidates.set(device, Array.from(values));
  });

  return candidates;
}

/**
 * <summary>
 * Normalizes the scheduled-switch device array into current runtime records.
 * Invalid identities are skipped, while the returned error flag tells the
 * platform to retain unmatched cache entries instead of removing accessories.
 * </summary>
 * @param {object} config Platform configuration object.
 * @param {Function|object} log Homebridge logger.
 * @param {WeakMap<object, Array<string>>} legacyIdentityCandidates Previous IDs.
 * @param {WeakSet<object>} invalidDevices Raw devices rejected by ID resolution.
 * @returns {object} Valid devices and whether any configuration errors occurred.
 */
function normalizeDeviceConfigs(config, log, legacyIdentityCandidates, invalidDevices) {
  if (!config || typeof config !== 'object' || config.devices === undefined || config.devices === null) {
    return { devices: [], hasErrors: false };
  }

  if (!Array.isArray(config.devices)) {
    writeWarning(log, 'JsgScheduledSwitch devices must be an array. No scheduled switches were loaded.');
    return { devices: [], hasErrors: true };
  }

  const normalizedDevices = [];
  let hasErrors = false;

  config.devices.forEach((rawDevice, index) => {
    if (!rawDevice || typeof rawDevice !== 'object' || Array.isArray(rawDevice)) {
      hasErrors = true;
      writeWarning(log, `JsgScheduledSwitch device ${index + 1} must be an object and was skipped.`);
      return;
    }

    if (invalidDevices && invalidDevices.has(rawDevice)) {
      hasErrors = true;
      return;
    }

    const deviceConfig = normalizeDeviceConfig(rawDevice, index, log, legacyIdentityCandidates);

    if (!deviceConfig) {
      hasErrors = true;
      return;
    }

    normalizedDevices.push(deviceConfig);
  });

  const duplicateResolution = removeDuplicateIds(normalizedDevices, log);

  return {
    devices: duplicateResolution.devices,
    hasErrors: hasErrors || duplicateResolution.hasErrors
  };
}

/**
 * <summary>
 * Converts one scheduled switch into the current singleton identity and behavior
 * shape. Its configured ID owns only the base path. Namespace is added by code
 * when the complete UUID seed is assembled.
 * </summary>
 * @param {object} rawDevice Raw device config object.
 * @param {number} index Zero-based device index used for defaults and warnings.
 * @param {Function|object} log Homebridge logger.
 * @param {WeakMap<object, Array<string>>} legacyIdentityCandidates Previous IDs.
 * @returns {object|null} Normalized device config or null when invalid.
 */
function normalizeDeviceConfig(rawDevice, index, log, legacyIdentityCandidates) {
  const name = normalizeName(rawDevice.name, index);
  const id = normalizeIdentityPath(rawDevice.id);
  const identity = createAccessoryIdentity(PLUGIN_NAME, id);

  if (!id || !identity) {
    writeWarning(log, `JsgScheduledSwitch device ${index + 1} has no valid current identity and was skipped.`);
    return null;
  }

  const legacyBaseIds = Array.from(new Set(legacyIdentityCandidates.get(rawDevice) || []))
    .filter((candidate) => candidate && candidate !== id);
  const legacySeeds = Array.from(new Set(legacyBaseIds.map((candidate) =>
    `${PLUGIN_NAME}:${candidate}`)));
  const entries = Array.isArray(rawDevice.entries) ? rawDevice.entries : rawDevice.schedule;

  return {
    id,
    identity,
    legacyBaseIds,
    legacySeeds,
    name,
    entries,
    inverseState: Boolean(rawDevice.inverseState),
    enableIntervalCheck: Boolean(rawDevice.enableIntervalCheck),
    intervalMinutes: normalizeIntervalMinutes(rawDevice.intervalMinutes)
  };
}

/**
 * <summary>
 * Performs a final defensive duplicate check in the plugin-wide base-ID domain.
 * ID preparation already reserves this domain, but this guard prevents ambiguous
 * reconciliation if a future caller bypasses that stage.
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
      writeWarning(log, `JsgScheduledSwitch device '${device.name}' uses duplicate id '${device.id}' and was skipped.`);
      return;
    }

    usedIds.add(device.id);
    uniqueDevices.push(device);
  });

  return { devices: uniqueDevices, hasErrors };
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
 * Normalizes the user-visible device name and falls back to a numbered default
 * when config is missing or blank. Homebridge should never receive an empty switch
 * or accessory name.
 * </summary>
 * @param {string} value Configured device name.
 * @param {number} index Zero-based device index used for fallback naming.
 * @returns {string} Safe switch name.
 */
function normalizeName(value, index) {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  return `${DEFAULT_DEVICE_NAME} ${index + 1}`;
}

/**
 * <summary>
 * Reproduces the exact identifier normalization used before the shared
 * plugin-prefixed ID contract. It is used only to locate a cached accessory
 * during migration and never becomes the new automatically generated config ID.
 * </summary>
 * @param {*} value Legacy device name or fallback source.
 * @returns {string} Legacy normalized identifier used by earlier accessory UUIDs.
 */
function createLegacyIdentifier(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

  return normalized || 'jsg-scheduled-switch';
}

/**
 * <summary>
 * Normalizes the optional interval length used for periodic checks. The value is
 * expressed in minutes and clamped to one local day because interval checks are
 * aligned against the midnight-to-midnight grid.
 * </summary>
 * @param {number|string} value Configured interval in minutes.
 * @returns {number} Clamped interval in minutes.
 */
function normalizeIntervalMinutes(value) {
  const parsedValue = Number(value);

  if (!Number.isFinite(parsedValue)) {
    return DEFAULT_INTERVAL_MINUTES;
  }

  return Math.min(Math.max(Math.floor(parsedValue), MIN_INTERVAL_MINUTES), MAX_INTERVAL_MINUTES);
}

/**
 * <summary>
 * Calculates a safe timeout delay to a target date. The delay includes a small
 * buffer so boundary handlers evaluate just after the configured local minute
 * has become active rather than a few milliseconds early.
 * </summary>
 * @param {Date} targetDate Target local date and time.
 * @returns {number} Delay in milliseconds.
 */
function calculateDelayTo(targetDate) {
  return Math.max(250, targetDate.getTime() - Date.now() + 250);
}

/**
 * <summary>
 * Creates a timeout and releases it from keeping the Node.js process alive when
 * the runtime supports `unref`. Homebridge owns the process lifecycle, so plugin
 * timers should not prevent a clean shutdown.
 * </summary>
 * @param {Function} callback Timer callback.
 * @param {number} delayMs Delay in milliseconds.
 * @returns {object} Node.js timeout handle.
 */
function setManagedTimeout(callback, delayMs) {
  const timer = setTimeout(callback, delayMs);

  if (timer && typeof timer.unref === 'function') {
    timer.unref();
  }

  return timer;
}

/**
 * <summary>
 * Creates a stable serial number for one virtual switch. Homebridge only needs a
 * locally stable value here, and using the normalized device id keeps diagnostics
 * readable when multiple switches are configured.
 * </summary>
 * @param {string} id Normalized device identifier.
 * @returns {string} Stable serial number.
 */
function createSerialNumber(id) {
  return `jsg-scheduled-switch-${id || 'device'}`;
}

/**
 * <summary>
 * Formats a switch value for log messages. Centralizing this keeps state
 * wording consistent across manual writes, schedule triggers, and interval
 * checks.
 * </summary>
 * @param {boolean} value Switch state.
 * @returns {string} Lowercase state label.
 */
function formatState(value) {
  return Boolean(value) ? 'on' : 'off';
}

/**
 * <summary>
 * Writes informational messages through the Homebridge logger while tolerating
 * older logger shapes. Diagnostics should be useful but must never become a
 * startup dependency for the virtual switch platform.
 * </summary>
 * @param {Function|object} log Homebridge logger.
 * @param {string} message Informational message.
 */
function writeInfo(log, message) {
  if (log && typeof log.info === 'function') {
    log.info(message);
    return;
  }

  if (typeof log === 'function') {
    log(message);
  }
}

/**
 * <summary>
 * Writes warning messages through the Homebridge logger while tolerating older
 * logger shapes. Config validation should point at mistakes without preventing
 * compatible mocked or older logger implementations from loading the plugin.
 * </summary>
 * @param {Function|object} log Homebridge logger.
 * @param {string} message Warning message.
 */
function writeWarning(log, message) {
  if (log && typeof log.warn === 'function') {
    log.warn(message);
    return;
  }

  if (typeof log === 'function') {
    log(message);
  }
}

