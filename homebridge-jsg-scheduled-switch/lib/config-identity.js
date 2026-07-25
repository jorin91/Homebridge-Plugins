'use strict';

const fs = require('fs');
const path = require('path');

const IDENTITY_SCHEMA_VERSION = 1;

/**
 * <summary>
 * Resolves every configured base ID before Homebridge reconciles accessories.
 * Present values are canonically normalized and remain authoritative. Only a
 * genuinely absent property is generated from its owning device name. Changed
 * values are persisted before reconciliation so later display-name and behavior
 * changes continue to use the same logical identity.
 * </summary>
 * @param {object} options Identity preparation options.
 * @param {object} options.config Runtime platform config supplied by Homebridge.
 * @param {object} options.api Homebridge API used to locate config.json.
 * @param {Function|object} options.log Homebridge logger.
 * @param {string} options.pluginName Package-level Homebridge plugin name.
 * @param {string} options.platformName Platform alias stored in config.json.
 * @param {Array<object>} options.collections Device array definitions.
 * @returns {object} Resolution state, invalid-device tracking, and persistence outcome.
 */
function ensureStableDeviceIds(options) {
  const config = options && options.config;
  const collections = options && options.collections;
  const result = {
    didChange: false,
    hasErrors: false,
    invalidDevices: new WeakSet(),
    persistenceSucceeded: true
  };

  if (!config || typeof config !== 'object' || !Array.isArray(collections)) {
    result.hasErrors = true;
    return result;
  }

  const pluginNamespace = createEffectivePluginNamespace(options.pluginName);

  if (!pluginNamespace) {
    result.hasErrors = true;
    writeWarning(options.log, `${options.platformName} cannot resolve a valid effective plugin namespace.`);
    return result;
  }

  const usedIds = new Set();
  const generatedRecords = [];

  collections.forEach((collection) => {
    const devices = config[collection.key];

    if (!Array.isArray(devices)) {
      return;
    }

    devices.forEach((device, index) => {
      if (!device || typeof device !== 'object' || Array.isArray(device)) {
        return;
      }

      if (!Object.prototype.hasOwnProperty.call(device, 'id')) {
        generatedRecords.push({
          collection,
          device,
          index
        });
        return;
      }

      const configuredId = resolveConfiguredIdentity(device.id);

      if (!configuredId || !isValidBaseIdentityPath(configuredId, pluginNamespace)) {
        result.hasErrors = true;
        result.invalidDevices.add(device);
        writeWarning(
          options.log,
          `${options.platformName} ${collection.key} item ${index + 1} has an invalid id. The existing id property must contain a usable identity path.`
        );
        return;
      }

      if (device.id !== configuredId) {
        device.id = configuredId;
        result.didChange = true;
      }

      if (usedIds.has(configuredId)) {
        result.hasErrors = true;
        result.invalidDevices.add(device);
        writeWarning(
          options.log,
          `${options.platformName} ${collection.key} item ${index + 1} uses duplicate id '${configuredId}' and was skipped.`
        );
        return;
      }

      usedIds.add(configuredId);
    });
  });

  generatedRecords.forEach((record) => {
    const generatedId = createGeneratedIdentifier(record.device.name);

    if (!generatedId || !isValidBaseIdentityPath(generatedId, pluginNamespace)) {
      result.hasErrors = true;
      result.invalidDevices.add(record.device);
      writeWarning(
        options.log,
        `${options.platformName} ${record.collection.key} item ${record.index + 1} cannot generate an id because its name does not produce a usable identity path.`
      );
      return;
    }

    const stableId = reserveUniqueIdentifier(generatedId, usedIds);
    record.device.id = stableId;
    result.didChange = true;
  });

  if (result.didChange) {
    result.persistenceSucceeded = persistDeviceIds(options);

    if (!result.persistenceSucceeded) {
      result.hasErrors = true;
    }
  }

  return result;
}

/**
 * <summary>
 * Canonicalizes a configured identity field without invoking generation.
 * Configuration values must be strings and must produce a non-empty canonical
 * path whose structural colon separators do not create empty segments.
 * </summary>
 * @param {*} value Configured identifier value.
 * @returns {string|null} Canonical configured path or null when invalid.
 */
function resolveConfiguredIdentity(value) {
  if (typeof value !== 'string') {
    return null;
  }

  return normalizeIdentityPath(value);
}

/**
 * <summary>
 * Generates the initial base ID from the owning device name. The generated value
 * contains only the base path because the plugin namespace is code-owned and is
 * added later when the complete Homebridge UUID seed is assembled.
 * </summary>
 * @param {*} deviceName Configured owning device name.
 * @returns {string|null} Canonical generated base ID or null when unusable.
 */
function createGeneratedIdentifier(deviceName) {
  if (typeof deviceName !== 'string' || !deviceName.trim()) {
    return null;
  }

  return normalizeIdentityPath(deviceName);
}

/**
 * <summary>
 * Reserves a unique generated base ID across the combined device domain.
 * Deterministic numeric suffixes are appended to the final path segment while
 * explicit configured IDs retain priority.
 * </summary>
 * @param {string} baseId Preferred canonical generated base ID.
 * @param {Set<string>} usedIds IDs already reserved during this startup.
 * @returns {string} Unique canonical generated base ID.
 */
function reserveUniqueIdentifier(baseId, usedIds) {
  let candidate = baseId;
  let suffix = 1;

  while (usedIds.has(candidate)) {
    candidate = `${baseId}-${suffix}`;
    suffix += 1;
  }

  usedIds.add(candidate);
  return candidate;
}

/**
 * <summary>
 * Canonicalizes one complete identity path. Colons remain structural separators.
 * Every segment is lowercased, filtered to ASCII letters, digits, and hyphens,
 * then stripped of repeated and edge hyphens. Empty segments are invalid.
 * </summary>
 * @param {*} value Identity path source.
 * @returns {string|null} Canonical identity path or null when invalid.
 */
function normalizeIdentityPath(value) {
  const filteredValue = String(value === undefined || value === null ? '' : value)
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-:]/g, '');
  const segments = filteredValue.split(':').map((segment) => segment
    .replace(/-+/g, '-')
    .replace(/(^-|-$)/g, ''));

  if (!segments.length || segments.some((segment) => !segment)) {
    return null;
  }

  return segments.join(':');
}

/**
 * <summary>
 * Canonicalizes an atomic identity component and rejects structural paths.
 * Plugin namespaces and code-owned type values use this stricter formatter.
 * </summary>
 * @param {*} value Atomic identity component source.
 * @returns {string|null} Canonical single segment or null when invalid.
 */
function normalizeIdentitySegment(value) {
  const normalized = normalizeIdentityPath(value);

  if (!normalized || normalized.includes(':')) {
    return null;
  }

  return normalized;
}

/**
 * <summary>
 * Derives the code-owned effective plugin namespace. A normalized plugin name
 * that already contains jsg is used directly. Other plugin names receive one
 * jsg prefix before the candidate is normalized again.
 * </summary>
 * @param {*} pluginName Package-level Homebridge plugin name.
 * @returns {string|null} Canonical effective namespace or null when invalid.
 */
function createEffectivePluginNamespace(pluginName) {
  const normalizedPluginName = normalizeIdentitySegment(pluginName);

  if (!normalizedPluginName) {
    return null;
  }

  const candidate = normalizedPluginName.includes('jsg')
    ? normalizedPluginName
    : `jsg-${normalizedPluginName}`;

  return normalizeIdentitySegment(candidate);
}

/**
 * <summary>
 * Validates that a canonical configured base path owns only the base hierarchy.
 * A base path may contain child subsegments, but its first segment may not repeat
 * the code-owned effective plugin namespace from the complete runtime seed.
 * </summary>
 * @param {*} baseId Canonical configured base identity path.
 * @param {*} effectivePluginNamespace Canonical code-owned namespace.
 * @returns {boolean} True when the path is valid for a base ID field.
 */
function isValidBaseIdentityPath(baseId, effectivePluginNamespace) {
  const canonicalBaseId = normalizeIdentityPath(baseId);
  const namespace = normalizeIdentitySegment(effectivePluginNamespace);

  return Boolean(
    canonicalBaseId &&
    namespace &&
    canonicalBaseId.split(':')[0] !== namespace
  );
}

/**
 * <summary>
 * Builds the complete singleton accessory identity from the code-owned namespace
 * and configured base path. Every switch config in these plugins represents one
 * logical accessory, so type and extra parts are intentionally omitted.
 * </summary>
 * @param {*} pluginName Package-level Homebridge plugin name.
 * @param {*} baseId Canonical configured base identity path.
 * @returns {object|null} Structured identity and complete UUID seed or null.
 */
function createAccessoryIdentity(pluginName, baseId) {
  const namespace = createEffectivePluginNamespace(pluginName);
  const canonicalBaseId = normalizeIdentityPath(baseId);

  if (!namespace || !canonicalBaseId || !isValidBaseIdentityPath(canonicalBaseId, namespace)) {
    return null;
  }

  const seed = normalizeIdentityPath(`${namespace}:${canonicalBaseId}`);

  if (!seed) {
    return null;
  }

  return {
    namespace,
    version: IDENTITY_SCHEMA_VERSION,
    baseId: canonicalBaseId,
    type: null,
    parts: [],
    seed
  };
}

/**
 * <summary>
 * Reads structured logical identity metadata from a cached Homebridge accessory.
 * The raw object is returned so reconciliation can inspect supported older
 * identity values before replacing context with the current canonical shape.
 * </summary>
 * @param {object} accessory Cached Homebridge accessory.
 * @returns {object|null} Stored structured identity context or null.
 */
function readAccessoryIdentityContext(accessory) {
  const identity = accessory && accessory.context && accessory.context.identity;

  return identity && typeof identity === 'object' && !Array.isArray(identity)
    ? identity
    : null;
}

/**
 * <summary>
 * Checks whether cached structured context exactly identifies the current
 * singleton accessory. Exact comparison keeps current identity matching ahead
 * of UUID and supported legacy fallback candidates.
 * </summary>
 * @param {object} accessory Cached Homebridge accessory.
 * @param {object} identity Current structured accessory identity.
 * @returns {boolean} True when the cached context is an exact current match.
 */
function matchesAccessoryIdentityContext(accessory, identity) {
  const stored = readAccessoryIdentityContext(accessory);

  return Boolean(
    stored &&
    identity &&
    stored.namespace === identity.namespace &&
    stored.version === identity.version &&
    stored.baseId === identity.baseId &&
    Object.prototype.hasOwnProperty.call(stored, 'type') &&
    stored.type === null &&
    Array.isArray(stored.parts) &&
    stored.parts.length === 0
  );
}

/**
 * <summary>
 * Writes the current structured singleton identity into cached accessory
 * context. The accessory keeps its actual Homebridge UUID even when it was found
 * through a supported legacy seed.
 * </summary>
 * @param {object} accessory Homebridge accessory being created or retained.
 * @param {object} identity Current structured accessory identity.
 * @returns {boolean} True when the stored structured context changed.
 */
function writeAccessoryIdentityContext(accessory, identity) {
  if (!accessory || !identity) {
    return false;
  }

  if (!accessory.context || typeof accessory.context !== 'object') {
    accessory.context = {};
  }

  const didChange = !matchesAccessoryIdentityContext(accessory, identity);
  accessory.context.identity = {
    namespace: identity.namespace,
    version: identity.version,
    baseId: identity.baseId,
    type: null,
    parts: []
  };

  return didChange;
}

/**
 * <summary>
 * Reproduces the flat identifier normalizer used by version 0.1.6. It is used
 * only to locate cached accessories and plugin state after canonical path rules
 * begin preserving structural colons.
 * </summary>
 * @param {*} value Previous identifier source.
 * @returns {string|null} Previous flat identifier or null when unusable.
 */
function normalizeLegacyFlatIdentifier(value) {
  const normalized = String(value === undefined || value === null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/(^-|-$)/g, '');

  return normalized || null;
}

/**
 * <summary>
 * Reproduces the plugin-prefixed automatic ID created by version 0.1.6. This
 * value is a legacy lookup candidate only and is never generated for new config.
 * </summary>
 * @param {*} pluginName Package-level Homebridge plugin name.
 * @param {*} deviceName Previous owning device name.
 * @param {*} fallbackDeviceName Previous collection fallback value.
 * @returns {string|null} Previous generated base ID or null when unusable.
 */
function createLegacyGeneratedIdentifier(pluginName, deviceName, fallbackDeviceName) {
  const pluginSegment = normalizeLegacyPluginSegment(pluginName);
  const deviceSegment = normalizeLegacyFlatIdentifier(deviceName) ||
    normalizeLegacyFlatIdentifier(fallbackDeviceName) ||
    'accessory';

  return normalizeLegacyFlatIdentifier(`jsg-${pluginSegment}-${deviceSegment}`);
}

/**
 * <summary>
 * Reproduces the concise plugin segment embedded in version 0.1.6 generated IDs.
 * Npm scope, repeated homebridge packaging prefixes, and leading JSG owner
 * prefixes are removed in the same order as that release.
 * </summary>
 * @param {*} pluginName Package-level Homebridge plugin name.
 * @returns {string} Previous concise plugin segment.
 */
function normalizeLegacyPluginSegment(pluginName) {
  const rawName = String(pluginName || '');
  const unscopedName = rawName.includes('/') ? rawName.split('/').pop() : rawName;
  const normalized = normalizeLegacyFlatIdentifier(unscopedName) || '';
  const segments = normalized.split('-').filter(Boolean);

  while (segments[0] === 'homebridge' || segments[0] === 'jsg') {
    segments.shift();
  }

  return segments.join('-') || 'plugin';
}
/**
 * <summary>
 * Copies generated or normalized runtime identifiers into the matching
 * platform block in
 * Homebridge config.json. Only device id fields are changed. Existing platform
 * settings and device behavior properties are read from disk and preserved.
 * Failures are logged without aborting accessory startup.
 * </summary>
 * @param {object} options Identity preparation options supplied by the platform.
 * @returns {boolean} True when config.json was updated successfully.
 */
function persistDeviceIds(options) {
  try {
    const configPath = resolveConfigPath(options.api);

    if (!configPath) {
      writeWarning(options.log, `${options.platformName} could not persist stable device IDs because Homebridge did not expose a config path.`);
      return false;
    }

    const rawConfig = fs.readFileSync(configPath, 'utf8');
    const hasByteOrderMark = rawConfig.charCodeAt(0) === 0xFEFF;
    const parseableConfig = hasByteOrderMark ? rawConfig.slice(1) : rawConfig;
    const homebridgeConfig = JSON.parse(parseableConfig);
    const platformConfig = findPlatformConfig(homebridgeConfig, options.platformName, options.config);

    if (!platformConfig) {
      writeWarning(options.log, `${options.platformName} could not find its platform block in Homebridge config.json. Stable device IDs were not persisted.`);
      return false;
    }

    const didCopyIds = copyDeviceIds(options.config, platformConfig, options.collections);

    if (!didCopyIds) {
      return true;
    }

    const indentation = detectIndentation(parseableConfig);
    const newline = parseableConfig.includes('\r\n') ? '\r\n' : '\n';
    const serializedConfig = JSON.stringify(homebridgeConfig, null, indentation).replace(/\n/g, newline);
    const output = `${hasByteOrderMark ? '\uFEFF' : ''}${serializedConfig}${newline}`;

    fs.writeFileSync(configPath, output, 'utf8');
    writeInfo(options.log, `${options.platformName} stored stable device IDs in Homebridge config.json.`);
    return true;
  } catch (error) {
    writeWarning(options.log, `${options.platformName} could not persist stable device IDs in Homebridge config.json: ${error.message}`);
    return false;
  }
}

/**
 * <summary>
 * Resolves Homebridge config.json through the public user path helper. A storage
 * path fallback supports compatible Homebridge versions or test doubles that do
 * not expose configPath directly.
 * </summary>
 * @param {object} api Homebridge API object.
 * @returns {string|null} Absolute config.json path or null when unavailable.
 */
function resolveConfigPath(api) {
  const user = api && api.user;

  if (user && typeof user.configPath === 'function') {
    return user.configPath();
  }

  if (user && typeof user.storagePath === 'function') {
    return path.join(user.storagePath(), 'config.json');
  }

  return null;
}

/**
 * <summary>
 * Finds the singular platform config block that belongs to the active plugin.
 * The optional platform label disambiguates accidental duplicate blocks. When no
 * unique match exists, the function refuses to write to avoid patching unrelated
 * plugin configuration.
 * </summary>
 * @param {object} homebridgeConfig Parsed Homebridge root config.
 * @param {string} platformName Platform alias to locate.
 * @param {object} runtimeConfig Active platform config supplied by Homebridge.
 * @returns {object|null} Matching persisted platform block or null.
 */
function findPlatformConfig(homebridgeConfig, platformName, runtimeConfig) {
  const platforms = homebridgeConfig && Array.isArray(homebridgeConfig.platforms)
    ? homebridgeConfig.platforms
    : [];
  const matches = platforms.filter((platform) => platform && platform.platform === platformName);

  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length > 1 && runtimeConfig && typeof runtimeConfig.name === 'string') {
    const namedMatches = matches.filter((platform) => platform.name === runtimeConfig.name);

    if (namedMatches.length === 1) {
      return namedMatches[0];
    }
  }

  return null;
}

/**
 * <summary>
 * Copies only stable identifier fields from the normalized in-memory config to
 * the same array positions in the persisted platform config. Array shape and all
 * non-identity properties remain untouched.
 * </summary>
 * @param {object} runtimeConfig Mutated platform config used by the plugin.
 * @param {object} persistedConfig Parsed platform block from config.json.
 * @param {Array<object>} collections Device collection definitions.
 * @returns {boolean} True when at least one persisted identifier changed.
 */
function copyDeviceIds(runtimeConfig, persistedConfig, collections) {
  let didChange = false;

  collections.forEach((collection) => {
    const runtimeDevices = runtimeConfig[collection.key];
    const persistedDevices = persistedConfig[collection.key];

    if (!Array.isArray(runtimeDevices) || !Array.isArray(persistedDevices)) {
      return;
    }

    runtimeDevices.forEach((runtimeDevice, index) => {
      const persistedDevice = persistedDevices[index];

      if (!runtimeDevice || typeof runtimeDevice !== 'object' ||
          !persistedDevice || typeof persistedDevice !== 'object' ||
          persistedDevice.id === runtimeDevice.id) {
        return;
      }

      persistedDevice.id = runtimeDevice.id;
      didChange = true;
    });
  });

  return didChange;
}

/**
 * <summary>
 * Detects the existing JSON indentation so writing generated identifiers keeps
 * Homebridge config formatting consistent with the user's file.
 * </summary>
 * @param {string} rawConfig Existing Homebridge config text without a BOM.
 * @returns {string|number} JSON.stringify indentation argument.
 */
function detectIndentation(rawConfig) {
  const match = rawConfig.match(/\r?\n([\t ]+)"/);

  return match ? match[1] : 4;
}

/**
 * <summary>
 * Writes an informational Homebridge log message when the logger supports it.
 * </summary>
 * @param {Function|object} log Homebridge logger.
 * @param {string} message Message to write.
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
 * Writes a non-fatal Homebridge warning when identity persistence cannot safely
 * update config.json. Accessory startup continues with the generated runtime ID.
 * </summary>
 * @param {Function|object} log Homebridge logger.
 * @param {string} message Warning to write.
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

module.exports = {
  createAccessoryIdentity,
  createEffectivePluginNamespace,
  createGeneratedIdentifier,
  createLegacyGeneratedIdentifier,
  ensureStableDeviceIds,
  isValidBaseIdentityPath,
  matchesAccessoryIdentityContext,
  normalizeIdentityPath,
  normalizeIdentitySegment,
  normalizeLegacyFlatIdentifier,
  readAccessoryIdentityContext,
  writeAccessoryIdentityContext
};
