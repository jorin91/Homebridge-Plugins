'use strict';

const { JsonSourceFormat } = require('./json-source-format');

/**
 * <summary>
 * Registers source-format handlers behind a narrow parse, path-validation, and value-read contract. The platform
 * and runtime depend on this registry rather than JSON directly, so another source representation can be added
 * without rewriting polling, mapping normalization, accessory lifecycle, or HomeKit publication.
 * </summary>
 */
class SourceFormatRegistry {
  /**
   * <summary>
   * Creates a source format registry and optionally registers an initial set of named handlers.
   * </summary>
   * @param {ReadonlyArray<{type: string, handler: object}>} registrations Initial source format registrations.
   */
  constructor(registrations = []) {
    this.handlers = new Map();

    for (const registration of registrations) {
      this.register(registration.type, registration.handler);
    }
  }

  /**
   * <summary>
   * Adds one source format implementation after validating the complete extension contract. Existing names cannot
   * be replaced accidentally, which keeps configuration semantics stable for the lifetime of a plugin process.
   * </summary>
   * @param {string} type Lowercase source type identifier used in configuration.
   * @param {object} handler Parser and path reader implementation.
   * @returns {SourceFormatRegistry} This registry for controlled setup chaining.
   * @throws {TypeError} When the name, handler contract, or uniqueness requirement is invalid.
   */
  register(type, handler) {
    if (typeof type !== 'string' || type.trim() === '' || type !== type.toLowerCase()) {
      throw new TypeError('Source format type names must be non-empty lowercase strings');
    }

    validateHandler(type, handler);

    if (this.handlers.has(type)) {
      throw new TypeError(`Source format is already registered: ${type}`);
    }

    this.handlers.set(type, handler);
    return this;
  }

  /**
   * <summary>
   * Determines whether a format identifier is currently implemented by the plugin.
   * </summary>
   * @param {string} type Normalized source type identifier.
   * @returns {boolean} True when a handler has been registered.
   */
  has(type) {
    return this.handlers.has(type);
  }

  /**
   * <summary>
   * Retrieves the handler for a normalized source type without exposing the internal mutable map.
   * </summary>
   * @param {string} type Normalized source type identifier.
   * @returns {object|undefined} Registered handler or undefined when unsupported.
   */
  get(type) {
    return this.handlers.get(type);
  }

  /**
   * <summary>
   * Lists the supported source type identifiers in registration order for diagnostics and future user interfaces.
   * </summary>
   * @returns {ReadonlyArray<string>} Immutable snapshot of registered type names.
   */
  list() {
    return Object.freeze(Array.from(this.handlers.keys()));
  }
}

/**
 * <summary>
 * Validates one source format implementation. Source handlers intentionally own their path language as well as
 * parsing, which prevents JSON assumptions from leaking into generic configuration or runtime code.
 * </summary>
 * @param {string} type Source type name used to make failures actionable.
 * @param {object} handler Candidate source format handler.
 * @returns {void}
 * @throws {TypeError} When any required operation is missing.
 */
function validateHandler(type, handler) {
  if (!handler || typeof handler !== 'object') {
    throw new TypeError(`Source format ${type} requires a handler object`);
  }

  for (const method of ['parse', 'validatePath', 'read']) {
    if (typeof handler[method] !== 'function') {
      throw new TypeError(`Source format ${type} requires a ${method} method`);
    }
  }
}

/**
 * <summary>
 * Creates the production source-format registry. JSON is the only initial implementation, while the registry
 * boundary is already complete for future formats.
 * </summary>
 * @returns {SourceFormatRegistry} Registry containing the JSON source format.
 */
function createDefaultSourceFormatRegistry() {
  return new SourceFormatRegistry([
    {
      type: 'json',
      handler: new JsonSourceFormat(),
    },
  ]);
}

module.exports = {
  SourceFormatRegistry,
  createDefaultSourceFormatRegistry,
};
