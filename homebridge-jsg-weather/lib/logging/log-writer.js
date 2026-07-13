'use strict';

/**
 * <summary>
 * Writes an informational message through the Homebridge logger when that capability is available.
 * This adapter also accepts lightweight logger doubles used by tests and integrations.
 * </summary>
 * @param {object} log Homebridge logger or compatible logger object.
 * @param {string} message Safe message that may be written to the log.
 * @returns {void}
 * @sideEffect Writes one informational log entry when supported.
 */
function writeInfo(log, message) {
  if (log && typeof log.info === 'function') {
    log.info(message);
  }
}

/**
 * <summary>
 * Writes a warning through the best warning-capable method exposed by the supplied logger.
 * Homebridge commonly exposes both warn and error methods, so error is used only as a fallback.
 * </summary>
 * @param {object} log Homebridge logger or compatible logger object.
 * @param {string} message Safe message that may be written to the log.
 * @returns {void}
 * @sideEffect Writes one warning or error log entry when supported.
 */
function writeWarning(log, message) {
  if (log && typeof log.warn === 'function') {
    log.warn(message);
    return;
  }

  if (log && typeof log.error === 'function') {
    log.error(message);
  }
}

/**
 * <summary>
 * Writes diagnostic detail only when the logger exposes a debug method.
 * Callers must still ensure that the supplied message contains no source credentials or response bodies.
 * </summary>
 * @param {object} log Homebridge logger or compatible logger object.
 * @param {string} message Safe diagnostic message.
 * @returns {void}
 * @sideEffect Writes one debug log entry when supported.
 */
function writeDebug(log, message) {
  if (log && typeof log.debug === 'function') {
    log.debug(message);
  }
}

/**
 * <summary>
 * Converts an unknown thrown value into a concise message for controlled internal errors.
 * This function does not make arbitrary error text safe when it may already contain a credential.
 * </summary>
 * @param {unknown} error Thrown value to describe.
 * @returns {string} Human-readable error text.
 */
function formatError(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error);
}

module.exports = {
  writeInfo,
  writeWarning,
  writeDebug,
  formatError,
};
