'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMappingKey } = require('../lib/mappings/mapping-identity');
const { SourcePoller } = require('../lib/runtime/source-poller');
const { WeatherAccessoryRuntime } = require('../lib/runtime/weather-accessory-runtime');
const { createDefaultSourceFormatRegistry } = require('../lib/sources/source-format-registry');
const { WeatherUnitRegistry } = require('../lib/units/weather-unit-registry');

/**
 * <summary>
 * Converts a raw source value into a finite number and rejects unusable provider values.
 * </summary>
 * @param {unknown} value Raw mapped value.
 * @returns {number} Finite numeric value.
 * @throws {TypeError} When the source value is not finite.
 */
function normalizeFiniteNumber(value) {
  const result = Number(value);
  if (!Number.isFinite(result)) {
    throw new TypeError('A finite number is required');
  }
  return result;
}

/**
 * <summary>
 * Creates one reusable Celsius unit definition for all differently named runtime mappings in this test module.
 * </summary>
 * @returns {WeatherUnitRegistry} Test-only unit registry.
 */
function createRuntimeUnitRegistry() {
  return new WeatherUnitRegistry([
    {
      unit: '°C',
      automationKind: 'numeric',
      characteristicUuid: 'uuid:test:celsius',
      characteristicProps: { format: 'float', unit: 'celsius', perms: ['pr', 'ev'] },
      normalize: normalizeFiniteNumber,
      neutralValue: -273.15,
    },
  ]);
}

/**
 * <summary>
 * Creates one normalized Celsius mapping with the hidden deterministic identity consumed by runtime publication.
 * </summary>
 * @param {string} name User-visible measurement name.
 * @param {string} path JSON source path for the measurement.
 * @returns {{key: string, name: string, unit: string, path: string}} Normalized mapping object.
 */
function createRuntimeMapping(name, path) {
  return { key: createMappingKey(name, '°C'), name, unit: '°C', path };
}

/**
 * <summary>
 * Creates a service-manager double that records normal publication, per-key neutralization, and source-wide fallback.
 * </summary>
 * @returns {object} Service-manager double with captured calls.
 */
function createServiceManagerDouble() {
  const published = [];
  const neutralized = [];
  const allNeutralized = [];

  return {
    published,
    neutralized,
    allNeutralized,

    /**
     * <summary>
     * Accepts accessory metadata configuration without producing HomeKit side effects.
     * </summary>
     * @param {string} _name Configured accessory name.
     * @returns {void}
     */
    configureAccessoryInformation(_name) {},

    /**
     * <summary>
     * Accepts service reconciliation without constructing fake HomeKit services.
     * </summary>
     * @param {ReadonlyArray<object>} _mappings Active normalized mappings.
     * @returns {void}
     */
    reconcile(_mappings) {},

    /**
     * <summary>
     * Records one normalized publication selected by hidden mapping key.
     * </summary>
     * @param {string} mappingKey Deterministic internal mapping identity.
     * @param {unknown} value Normalized value.
     * @returns {void}
     * @sideEffect Appends one publication record.
     */
    publish(mappingKey, value) {
      published.push({ mappingKey, value });
    },

    /**
     * <summary>
     * Records neutralization of one specific mapping without affecting adjacent readings.
     * </summary>
     * @param {string} mappingKey Deterministic internal mapping identity.
     * @returns {void}
     * @sideEffect Appends the key to the neutralization collection.
     */
    publishNeutral(mappingKey) {
      neutralized.push(mappingKey);
    },

    /**
     * <summary>
     * Records source-wide neutralization after transport or document parsing failure.
     * </summary>
     * @param {ReadonlyArray<object>} mappings Active normalized mappings.
     * @returns {void}
     * @sideEffect Appends a mapping snapshot to the source-wide fallback collection.
     */
    publishAllNeutral(mappings) {
      allNeutralized.push(Array.from(mappings));
    },

    /**
     * <summary>
     * Accepts runtime disposal without retaining callbacks or external resources.
     * </summary>
     * @returns {void}
     */
    dispose() {},
  };
}

/**
 * <summary>
 * Creates a logger double that records safe runtime warning and informational messages.
 * </summary>
 * @returns {object} Logger double with captured message collections.
 */
function createRuntimeLogger() {
  const warnings = [];
  const information = [];

  return {
    warnings,
    information,

    /**
     * <summary>
     * Records one warning emitted by runtime fallback handling.
     * </summary>
     * @param {string} message Warning text.
     * @returns {void}
     * @sideEffect Appends the message to the warning collection.
     */
    warn(message) {
      warnings.push(message);
    },

    /**
     * <summary>
     * Records one informational message emitted by runtime lifecycle handling.
     * </summary>
     * @param {string} message Informational text.
     * @returns {void}
     * @sideEffect Appends the message to the information collection.
     */
    info(message) {
      information.push(message);
    },
  };
}

/**
 * <summary>
 * Verifies polling begins immediately and never schedules another cycle before the active task settles.
 * </summary>
 * @returns {Promise<void>} Promise settling after two manually controlled poll cycles.
 */
async function sourcePollerStartsImmediatelyWithoutOverlap() {
  let callCount = 0;
  let activeCount = 0;
  let maximumActiveCount = 0;
  let resolveCurrentTask;
  const scheduled = [];

  /**
   * <summary>
   * Starts one manually controlled polling task while tracking active concurrency.
   * </summary>
   * @returns {Promise<void>} Promise resolved externally by this test.
   * @sideEffect Updates invocation and concurrency counters.
   */
  async function controlledTask() {
    callCount += 1;
    activeCount += 1;
    maximumActiveCount = Math.max(maximumActiveCount, activeCount);
    await new Promise(
      /**
       * <summary>
       * Captures the resolver used to settle the currently active polling task.
       * </summary>
       * @param {Function} resolve Promise resolver.
       * @returns {void}
       */
      function captureResolver(resolve) {
        resolveCurrentTask = resolve;
      },
    );
    activeCount -= 1;
  }

  /**
   * <summary>
   * Captures each future polling callback instead of using a real clock.
   * </summary>
   * @param {Function} callback Scheduled poll callback.
   * @param {number} delay Configured delay in milliseconds.
   * @returns {object} Synthetic timer handle.
   * @sideEffect Adds the callback and delay to the schedule collection.
   */
  function captureTimeout(callback, delay) {
    const handle = { callback, delay };
    scheduled.push(handle);
    return handle;
  }

  /**
   * <summary>
   * Accepts timer cancellation because overlap, rather than cancellation, is asserted by this test.
   * </summary>
   * @param {object} _handle Synthetic timer handle.
   * @returns {void}
   */
  function ignoreClearTimeout(_handle) {}

  const poller = new SourcePoller({
    task: controlledTask,
    intervalMs: 300000,
    setTimeoutImpl: captureTimeout,
    clearTimeoutImpl: ignoreClearTimeout,
  });

  poller.start();
  const firstFlight = poller.inFlight;
  assert.equal(callCount, 1);
  assert.equal(scheduled.length, 0);
  resolveCurrentTask();
  await firstFlight;
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 300000);

  scheduled[0].callback();
  const secondFlight = poller.inFlight;
  assert.equal(callCount, 2);
  assert.equal(maximumActiveCount, 1);
  poller.stop();
  resolveCurrentTask();
  await secondFlight;
  assert.equal(scheduled.length, 1);
  assert.equal(maximumActiveCount, 1);
}

/**
 * <summary>
 * Verifies stopping a waiting poller cancels its scheduled timeout and prevents delayed work from executing.
 * </summary>
 * @returns {Promise<void>} Promise settling after timer cancellation verification.
 */
async function sourcePollerStopCancelsWaitingTimer() {
  let taskCalls = 0;
  let scheduledCallback;
  const timerHandle = { id: 1 };
  const clearedHandles = [];

  /**
   * <summary>
   * Completes immediately while recording one polling task invocation.
   * </summary>
   * @returns {Promise<void>} Already fulfilled task promise.
   * @sideEffect Increments the invocation counter.
   */
  async function immediateTask() {
    taskCalls += 1;
  }

  /**
   * <summary>
   * Captures the waiting timer callback and returns a stable synthetic handle.
   * </summary>
   * @param {Function} callback Scheduled poll callback.
   * @param {number} _delay Configured delay in milliseconds.
   * @returns {object} Stable synthetic timer handle.
   */
  function captureWaitingTimeout(callback, _delay) {
    scheduledCallback = callback;
    return timerHandle;
  }

  /**
   * <summary>
   * Records cancellation of the synthetic waiting timer.
   * </summary>
   * @param {object} handle Synthetic timer handle.
   * @returns {void}
   * @sideEffect Appends the handle to the cancellation collection.
   */
  function recordClearTimeout(handle) {
    clearedHandles.push(handle);
  }

  const poller = new SourcePoller({
    task: immediateTask,
    intervalMs: 1000,
    setTimeoutImpl: captureWaitingTimeout,
    clearTimeoutImpl: recordClearTimeout,
  });
  poller.start();
  await poller.inFlight;
  poller.stop();
  scheduledCallback();

  assert.equal(taskCalls, 1);
  assert.deepEqual(clearedHandles, [timerHandle]);
}

/**
 * <summary>
 * Creates one runtime with standard test collaborators and the supplied mappings and source client.
 * </summary>
 * @param {ReadonlyArray<object>} mappings Normalized mappings exercised by the runtime.
 * @param {object} sourceClient Text source-client double.
 * @param {object} serviceManager Publication recorder.
 * @param {object} logger Runtime logger double.
 * @returns {WeatherAccessoryRuntime} Configured runtime ready for an explicit refresh.
 */
function createRuntime(mappings, sourceClient, serviceManager, logger) {
  return new WeatherAccessoryRuntime({
    config: {
      sourceType: 'json',
      source: 'https://api.example.test/weather',
      intervalMinutes: 5,
      name: 'Test weather',
      mappings,
    },
    unitRegistry: createRuntimeUnitRegistry(),
    sourceFormatRegistry: createDefaultSourceFormatRegistry(),
    sourceClient,
    serviceManager,
    log: logger,
  });
}

/**
 * <summary>
 * Verifies valid readings sharing one unit are normalized and published by distinct hidden mapping keys.
 * </summary>
 * @returns {Promise<void>} Promise settling after the runtime refresh.
 */
async function weatherRuntimePublishesByMappingKey() {
  const serviceManager = createServiceManagerDouble();
  const logger = createRuntimeLogger();
  const temperature = createRuntimeMapping('Temperature', '/current/temperature_2m');
  const dewPoint = createRuntimeMapping('Dew point', '/current/dew_point_2m');
  const sourceClient = {
    /**
     * <summary>
     * Returns a complete response for two differently named Celsius mappings.
     * </summary>
     * @returns {Promise<string>} JSON response text.
     */
    async readText() {
      return '{"current":{"temperature_2m":"18.5","dew_point_2m":11.25}}';
    },
  };

  await createRuntime([temperature, dewPoint], sourceClient, serviceManager, logger).refresh();

  assert.deepEqual(serviceManager.published, [
    { mappingKey: temperature.key, value: 18.5 },
    { mappingKey: dewPoint.key, value: 11.25 },
  ]);
  assert.deepEqual(serviceManager.neutralized, []);
  assert.deepEqual(serviceManager.allNeutralized, []);
}

/**
 * <summary>
 * Verifies invalid and missing readings neutralize only their corresponding keys while a same-unit valid mapping
 * continues to publish normally; missing fields remain an expected quiet fallback rather than a warning condition.
 * </summary>
 * @returns {Promise<void>} Promise settling after the partial-value refresh.
 */
async function weatherRuntimeNeutralizesOnlyInvalidOrMissingKeys() {
  const serviceManager = createServiceManagerDouble();
  const logger = createRuntimeLogger();
  const valid = createRuntimeMapping('Temperature', '/current/temperature_2m');
  const invalid = createRuntimeMapping('Dew point', '/current/dew_point_2m');
  const missing = createRuntimeMapping('Apparent temperature', '/current/apparent_temperature');
  const sourceClient = {
    /**
     * <summary>
     * Returns one valid, one nonnumeric, and one absent Celsius measurement.
     * </summary>
     * @returns {Promise<string>} Partial JSON response text.
     */
    async readText() {
      return '{"current":{"temperature_2m":18.5,"dew_point_2m":"not-a-number"}}';
    },
  };

  await createRuntime([valid, invalid, missing], sourceClient, serviceManager, logger).refresh();

  assert.deepEqual(serviceManager.published, [{ mappingKey: valid.key, value: 18.5 }]);
  assert.deepEqual(serviceManager.neutralized, [invalid.key, missing.key]);
  assert.equal(serviceManager.neutralized.includes(valid.key), false);
  assert.deepEqual(serviceManager.allNeutralized, []);
  assert.equal(logger.warnings.length, 1);
  assert.match(logger.warnings[0], /Dew point/);
}

/**
 * <summary>
 * Verifies complete transport failure delegates neutralization of every active mapping to the service manager.
 * </summary>
 * @returns {Promise<void>} Promise settling after the failed refresh.
 */
async function weatherRuntimeNeutralizesAllMappingsAfterSourceFailure() {
  const mappings = [
    createRuntimeMapping('Temperature', '/current/temperature_2m'),
    createRuntimeMapping('Dew point', '/current/dew_point_2m'),
  ];
  const serviceManager = createServiceManagerDouble();
  const logger = createRuntimeLogger();
  const sourceClient = {
    /**
     * <summary>
     * Simulates complete transport failure without exposing provider details.
     * </summary>
     * @returns {Promise<never>} Rejected source request.
     * @throws {Error} Always throws to exercise source-wide fallback.
     */
    async readText() {
      throw new Error('transport failed');
    },
  };

  await createRuntime(mappings, sourceClient, serviceManager, logger).refresh();

  assert.deepEqual(serviceManager.published, []);
  assert.deepEqual(serviceManager.neutralized, []);
  assert.deepEqual(serviceManager.allNeutralized, [mappings]);
  assert.match(logger.warnings.join('\n'), /neutral values were published/);
}

/**
 * <summary>
 * Verifies one runtime refresh downloads and parses exactly one shared source snapshot before resolving every
 * configured mapping from that same in-memory document. This prevents mappings from creating independent requests,
 * parsers, intervals, or repeated source-level work.
 * </summary>
 * @returns {Promise<void>} Promise settling after both mappings have been published from one shared snapshot.
 */
async function weatherRuntimeUsesOneSharedSourceSnapshot() {
  const mappings = [
    createRuntimeMapping('Temperature', '/temperature'),
    createRuntimeMapping('Dew point', '/dewPoint'),
  ];
  const serviceManager = createServiceManagerDouble();
  const logger = createRuntimeLogger();
  const snapshot = Object.freeze({
    '/temperature': 18.5,
    '/dewPoint': 11.25,
  });
  const resolvedPaths = [];
  let sourceReadCount = 0;
  let parseCount = 0;

  const sourceClient = {
    /**
     * <summary>
     * Returns one synthetic response body while counting complete source requests for the refresh cycle.
     * </summary>
     * @param {string} source Configured source URL.
     * @returns {Promise<string>} Synthetic source response body.
     * @sideEffect Increments the source request counter.
     */
    async readText(source) {
      assert.equal(source, 'https://api.example.test/weather');
      sourceReadCount += 1;
      return 'shared weather response';
    },
  };

  const formatHandler = {
    /**
     * <summary>
     * Converts the single synthetic response body into the stable object every mapping must share.
     * </summary>
     * @param {string} text Complete response body returned by the source client.
     * @returns {object} Shared immutable snapshot used for all mapping reads.
     * @sideEffect Increments the parse counter.
     */
    parse(text) {
      assert.equal(text, 'shared weather response');
      parseCount += 1;
      return snapshot;
    },

    /**
     * <summary>
     * Resolves one mapping from the parsed snapshot and verifies every invocation receives the identical object.
     * </summary>
     * @param {object} document Parsed source snapshot supplied by the runtime.
     * @param {string} path Mapping path being resolved.
     * @returns {unknown} Raw value stored at the requested test path.
     * @sideEffect Records the mapping path for complete fan-out verification.
     */
    read(document, path) {
      assert.equal(document, snapshot);
      resolvedPaths.push(path);
      return document[path];
    },
  };

  const sourceFormatRegistry = {
    /**
     * <summary>
     * Supplies the one instrumented format handler used to count parsing and shared-document reads.
     * </summary>
     * @param {string} sourceType Normalized configured source type.
     * @returns {object} Instrumented source format handler.
     */
    get(sourceType) {
      assert.equal(sourceType, 'json');
      return formatHandler;
    },
  };

  const runtime = new WeatherAccessoryRuntime({
    config: {
      sourceType: 'json',
      source: 'https://api.example.test/weather',
      intervalMinutes: 5,
      name: 'Test weather',
      mappings,
    },
    unitRegistry: createRuntimeUnitRegistry(),
    sourceFormatRegistry,
    sourceClient,
    serviceManager,
    log: logger,
  });

  await runtime.refresh();

  assert.equal(sourceReadCount, 1);
  assert.equal(parseCount, 1);
  assert.deepEqual(resolvedPaths, ['/temperature', '/dewPoint']);
  assert.deepEqual(serviceManager.published, [
    { mappingKey: mappings[0].key, value: 18.5 },
    { mappingKey: mappings[1].key, value: 11.25 },
  ]);
}

test('source poller starts immediately and prevents overlapping cycles', sourcePollerStartsImmediatelyWithoutOverlap);
test('source poller stop cancels a waiting timer', sourcePollerStopCancelsWaitingTimer);
test('weather runtime publishes same-unit values by mapping key', weatherRuntimePublishesByMappingKey);
test('weather runtime fetches and parses one shared snapshot for all mappings', weatherRuntimeUsesOneSharedSourceSnapshot);
test('weather runtime neutralizes only invalid or missing mapping keys', weatherRuntimeNeutralizesOnlyInvalidOrMissingKeys);
test('weather runtime neutralizes every mapping after source failure', weatherRuntimeNeutralizesAllMappingsAfterSourceFailure);
