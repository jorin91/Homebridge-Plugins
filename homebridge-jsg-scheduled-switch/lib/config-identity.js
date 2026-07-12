'use strict';

const fs = require('fs');
const path = require('path');

/**
 * <summary>
 * Assigns every configured device a stable unique identifier before Homebridge
 * reconciles cached accessories. Existing configured identifiers remain the
 * preferred identity. Missing identifiers are generated through the supplied
 * plugin-specific normalizer and are persisted to Homebridge config.json so a
 * later display-name or behavior change keeps using the same accessory UUID.
 * </summary>
 * @param {object} options Identity preparation options.
 * @param {object} options.config Runtime platform config supplied by Homebridge.
 * @param {object} options.api Homebridge API used to locate config.json.
 * @param {Function|object} options.log Homebridge logger.
 * @param {string} options.platformName Platform alias stored in config.json.
 * @param {Array<object>} options.collections Device array definitions.
 * @param {Function} options.normalizeId Plugin-specific identifier normalizer.
 * @param {Function} [options.resolveGeneratedId] Optional cached-accessory migration resolver.
 * @returns {boolean} True when one or more runtime config identifiers changed.
 */
function ensureStableDeviceIds(options) {
  const config = options && options.config;
  const collections = options && options.collections;

  if (!config || typeof config !== 'object' || !Array.isArray(collections)) {
    return false;
  }

  const usedIds = new Set();
  const deviceRecords = [];
  let didChange = false;

  collections.forEach((collection) => {
    const devices = config[collection.key];

    if (!Array.isArray(devices)) {
      return;
    }

    devices.forEach((device, index) => {
      if (!device || typeof device !== 'object' || Array.isArray(device)) {
        return;
      }

      const configuredId = normalizeOptionalIdentifier(device.id, options.normalizeId, collection.fallbackId);
      const name = normalizeDeviceName(device.name, collection.defaultName, index);

      deviceRecords.push({
        collection,
        configuredId,
        device,
        index,
        name
      });

      if (!configuredId) {
        return;
      }

      usedIds.add(configuredId);

      if (device.id !== configuredId) {
        device.id = configuredId;
        didChange = true;
      }
    });
  });

  deviceRecords.forEach((record) => {
    if (record.configuredId) {
      return;
    }

    const generatedSource = getLegacyIdentifierSource(record);
    const generatedId = options.normalizeId(generatedSource, record.collection.fallbackId);
    const resolvedGeneratedId = resolveGeneratedIdentifier(
      options.resolveGeneratedId,
      generatedId,
      record.collection,
      record.device,
      record.index
    );
    const stableId = reserveUniqueIdentifier(resolvedGeneratedId, usedIds);

    if (record.device.id !== stableId) {
      record.device.id = stableId;
      didChange = true;
    }
  });

  if (didChange) {
    persistDeviceIds(options);
  }

  return didChange;
}

/**
 * <summary>
 * Normalizes a user-supplied identifier only when it contains a meaningful
 * value. Empty or missing values remain absent so the normal name-based fallback
 * and cached-accessory migration path can generate the initial identity.
 * </summary>
 * @param {*} value Configured identifier value.
 * @param {Function} normalizeId Plugin-specific identifier normalizer.
 * @param {string} fallbackId Collection fallback identifier.
 * @returns {string|null} Normalized configured identifier or null when absent.
 */
function normalizeOptionalIdentifier(value, normalizeId, fallbackId) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  return normalizeId(value, fallbackId);
}

/**
 * <summary>
 * Applies the optional migration resolver to a newly generated identifier. The
 * resolver can confirm or recover the identifier already represented by a cached
 * accessory. Invalid resolver output falls back to the generated identifier so
 * startup cannot lose the legacy name-based identity.
 * </summary>
 * @param {Function} resolver Optional migration resolver.
 * @param {string} generatedId Identifier generated with the legacy name method.
 * @param {object} collection Current device collection definition.
 * @param {object} device Raw configured device.
 * @param {number} index Zero-based index within the collection.
 * @returns {string} Generated or recovered identifier.
 */
function resolveGeneratedIdentifier(resolver, generatedId, collection, device, index) {
  if (typeof resolver !== 'function') {
    return generatedId;
  }

  const resolvedId = resolver(generatedId, collection, device, index);

  return typeof resolvedId === 'string' && resolvedId ? resolvedId : generatedId;
}

/**
 * <summary>
 * Reserves a unique identifier across every device array owned by a platform.
 * Deterministic numeric suffixes keep duplicate generated identifiers valid while
 * preserving the existing first-match behavior for already configured devices.
 * </summary>
 * @param {string} baseId Preferred normalized identifier.
 * @param {Set<string>} usedIds Identifiers already reserved during this startup.
 * @returns {string} Unique identifier for the current device.
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
 * Produces the same fallback display name used by runtime config normalization.
 * Matching these defaults ensures first-run identifier persistence does not alter
 * the UUID that older plugin versions would have generated.
 * </summary>
 * @param {*} value Configured display name.
 * @param {string} defaultName Collection-specific default display name.
 * @param {number} index Zero-based collection index.
 * @returns {string} Configured or numbered fallback display name.
 */
function normalizeDeviceName(value, defaultName, index) {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  return `${defaultName} ${index + 1}`;
}

/**
 * <summary>
 * Returns the identifier source used by the plugin version being migrated. Most
 * collections used the normalized display name. A collection can provide a
 * missing-name prefix when an older implementation used an index fallback before
 * normalizing its display name.
 * </summary>
 * @param {object} record Prepared device identity record.
 * @returns {*} Legacy identifier source value.
 */
function getLegacyIdentifierSource(record) {
  const prefix = record.collection.missingNameIdPrefix;

  if (prefix && !record.device.name) {
    return `${prefix}-${record.index + 1}`;
  }

  return prefix ? record.device.name : record.name;
}

/**
 * <summary>
 * Copies generated runtime identifiers into the matching platform block in
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
      writeWarning(options.log, `${options.platformName} could not persist generated device IDs because Homebridge did not expose a config path.`);
      return false;
    }

    const rawConfig = fs.readFileSync(configPath, 'utf8');
    const hasByteOrderMark = rawConfig.charCodeAt(0) === 0xFEFF;
    const parseableConfig = hasByteOrderMark ? rawConfig.slice(1) : rawConfig;
    const homebridgeConfig = JSON.parse(parseableConfig);
    const platformConfig = findPlatformConfig(homebridgeConfig, options.platformName, options.config);

    if (!platformConfig) {
      writeWarning(options.log, `${options.platformName} could not find its platform block in Homebridge config.json. Generated device IDs were not persisted.`);
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
    writeInfo(options.log, `${options.platformName} stored generated device IDs in Homebridge config.json.`);
    return true;
  } catch (error) {
    writeWarning(options.log, `${options.platformName} could not persist generated device IDs in Homebridge config.json: ${error.message}`);
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
  ensureStableDeviceIds
};
