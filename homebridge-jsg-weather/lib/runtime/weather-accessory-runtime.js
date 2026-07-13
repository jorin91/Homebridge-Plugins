'use strict';

const { SourcePoller } = require('./source-poller');
const { writeInfo, writeWarning } = require('../logging/log-writer');

/**
 * <summary>
 * Coordinates source polling for the plugin's single accessory. It delegates document parsing and path resolution
 * to the selected source format, delegates value conversion to reusable unit definitions, and publishes by hidden
 * mapping key so multiple differently named measurements may share one unit without colliding.
 * </summary>
 */
class WeatherAccessoryRuntime {
  /**
   * <summary>
   * Creates a runtime with explicit collaborators so transport, source formats, units, HomeKit publication, and
   * scheduling remain independently extensible and testable.
   * </summary>
   * @param {object} options Normalized config and runtime collaborators.
   * @param {object} options.config Immutable normalized weather configuration.
   * @param {object} options.unitRegistry Plugin-owned reusable unit registry.
   * @param {object} options.sourceFormatRegistry Registered source-format handlers.
   * @param {object} options.sourceClient Text source transport client.
   * @param {object} options.serviceManager HomeKit value service manager.
   * @param {object} options.log Homebridge logger or compatible logger.
   * @param {Function} [options.pollerFactory] Factory used to create the non-overlapping source poller.
   */
  constructor({
    config,
    unitRegistry,
    sourceFormatRegistry,
    sourceClient,
    serviceManager,
    log,
    pollerFactory = createSourcePoller,
  }) {
    this.config = config;
    this.unitRegistry = unitRegistry;
    this.sourceFormatRegistry = sourceFormatRegistry;
    this.sourceClient = sourceClient;
    this.serviceManager = serviceManager;
    this.log = log;
    this.pollerFactory = pollerFactory;
    this.poller = undefined;
  }

  /**
   * <summary>
   * Reconciles all named mapping services and starts immediate polling when a source and supported format exist.
   * Missing source configuration keeps explicit per-unit neutral values visible and does not attempt network access.
   * </summary>
   * @returns {void}
   * @sideEffect Creates HomeKit services and may start asynchronous HTTP polling.
   */
  start() {
    this.serviceManager.configureAccessoryInformation(this.config.name);
    this.serviceManager.reconcile(this.config.mappings);

    const formatHandler = this.sourceFormatRegistry.get(this.config.sourceType);
    if (!formatHandler || !this.config.source) {
      this.serviceManager.publishAllNeutral(this.config.mappings);
      writeWarning(this.log, 'Weather polling is inactive because no usable source is configured');
      return;
    }

    this.poller = this.pollerFactory({
      task: this.refresh.bind(this),
      intervalMs: this.config.intervalMinutes * 60 * 1000,
      onError: this.handleUnexpectedPollingError.bind(this),
    });
    this.poller.start();
    writeInfo(this.log, `Weather polling started with a ${this.config.intervalMinutes} minute interval`);
  }

  /**
   * <summary>
   * Stops future refresh work, aborts the active transport request, and detaches cached HomeKit read handlers.
   * </summary>
   * @returns {void}
   * @sideEffect Cancels scheduling, signals network cancellation, and removes owned get handlers.
   */
  stop() {
    if (this.poller) {
      this.poller.stop();
      this.poller = undefined;
    }

    if (this.sourceClient && typeof this.sourceClient.abort === 'function') {
      this.sourceClient.abort();
    }

    this.serviceManager.dispose();
  }

  /**
   * <summary>
   * Downloads and parses one source document, then resolves and normalizes each named mapping independently. Missing
   * or invalid individual values receive their unit-owned neutral fallback. A complete transport or parsing failure
   * neutralizes every mapping so stale weather information is never presented as current.
   * </summary>
   * @returns {Promise<void>} Promise settling after every mapped characteristic has been updated.
   * @sideEffect Performs one source request and updates active HomeKit characteristic values.
   */
  async refresh() {
    const formatHandler = this.sourceFormatRegistry.get(this.config.sourceType);

    try {
      const text = await this.sourceClient.readText(this.config.source);
      const document = formatHandler.parse(text);

      for (const mapping of this.config.mappings) {
        this.publishMapping(document, mapping, formatHandler);
      }
    } catch {
      this.serviceManager.publishAllNeutral(this.config.mappings);
      writeWarning(this.log, 'Weather source refresh failed and neutral values were published');
    }
  }

  /**
   * <summary>
   * Resolves and normalizes one mapping in isolation. This boundary ensures one malformed path, incompatible unit,
   * or rejected value cannot block remaining measurements, including other mappings that use the same unit.
   * </summary>
   * @param {unknown} document Parsed source document.
   * @param {{key: string, name: string, unit: string, path: string}} mapping Normalized mapping.
   * @param {object} formatHandler Selected source-format handler.
   * @returns {void}
   * @sideEffect Publishes either one normalized value or that mapping's unit-specific neutral fallback.
   */
  publishMapping(document, mapping, formatHandler) {
    const definition = this.unitRegistry.get(mapping.unit);

    try {
      if (!definition) {
        throw new TypeError('Normalized mapping references an unavailable unit definition');
      }

      const rawValue = formatHandler.read(document, mapping.path);
      if (rawValue === undefined || rawValue === null) {
        this.serviceManager.publishNeutral(mapping.key);
        return;
      }

      const normalizedValue = definition.normalize(rawValue);
      this.serviceManager.publish(mapping.key, normalizedValue);
    } catch {
      this.serviceManager.publishNeutral(mapping.key);
      writeWarning(
        this.log,
        `Weather mapping ${mapping.name} with unit ${mapping.unit} could not read its source value and was neutralized`,
      );
    }
  }

  /**
   * <summary>
   * Contains scheduler-level failures that escape the normal refresh boundary and neutralizes all active mappings.
   * The thrown error text is intentionally not logged because third-party transport errors may embed secret URLs.
   * </summary>
   * @param {unknown} _error Unexpected polling failure.
   * @returns {void}
   * @sideEffect Publishes every mapping's unit-specific neutral fallback and writes a safe warning.
   */
  handleUnexpectedPollingError(_error) {
    this.serviceManager.publishAllNeutral(this.config.mappings);
    writeWarning(this.log, 'Unexpected weather polling failure and neutral values were published');
  }
}

/**
 * <summary>
 * Creates the production non-overlapping source poller. Keeping construction behind a factory allows tests to
 * capture refresh behavior without starting real timers.
 * </summary>
 * @param {object} options SourcePoller constructor options.
 * @returns {SourcePoller} Configured source poller.
 */
function createSourcePoller(options) {
  return new SourcePoller(options);
}

module.exports = {
  WeatherAccessoryRuntime,
  createSourcePoller,
};
