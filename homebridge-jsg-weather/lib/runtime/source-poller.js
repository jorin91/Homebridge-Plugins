'use strict';

/**
 * <summary>
 * Runs one asynchronous refresh immediately and then schedules the next refresh only after the previous task has
 * settled. Recursive timeouts prevent overlapping source requests when a server responds more slowly than the
 * configured interval.
 * </summary>
 */
class SourcePoller {
  /**
   * <summary>
   * Creates a stoppable poller with injectable timer operations for deterministic testing.
   * </summary>
   * @param {object} options Poller task, interval, error callback, and optional timer operations.
   * @param {Function} options.task Asynchronous refresh operation.
   * @param {number} options.intervalMs Delay after a completed task before the next run.
   * @param {Function} [options.onError] Callback for unexpected task failures.
   * @param {Function} [options.setTimeoutImpl] Timer scheduling implementation.
   * @param {Function} [options.clearTimeoutImpl] Timer cancellation implementation.
   */
  constructor({
    task,
    intervalMs,
    onError = ignorePollingError,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  }) {
    if (typeof task !== 'function') {
      throw new TypeError('SourcePoller requires a task function');
    }
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new TypeError('SourcePoller requires a positive intervalMs');
    }

    this.task = task;
    this.intervalMs = intervalMs;
    this.onError = onError;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.timer = undefined;
    this.running = false;
    this.inFlight = undefined;
  }

  /**
   * <summary>
   * Starts polling once and triggers the first refresh without waiting for the configured interval. Repeated start
   * calls are idempotent and do not create concurrent polling loops.
   * </summary>
   * @returns {void}
   * @sideEffect Begins asynchronous refresh work and later timer scheduling.
   */
  start() {
    if (this.running) {
      return;
    }

    this.running = true;
    this.inFlight = this.runCycle();
  }

  /**
   * <summary>
   * Stops future polling and cancels a waiting timeout. An already running task is allowed to settle because its
   * owning source client is separately responsible for aborting active network I/O during shutdown.
   * </summary>
   * @returns {void}
   * @sideEffect Cancels one scheduled timeout when present.
   */
  stop() {
    this.running = false;

    if (this.timer !== undefined) {
      this.clearTimeoutImpl(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * <summary>
   * Executes one refresh, reports unexpected failures, and schedules the next cycle only when polling remains active.
   * </summary>
   * @returns {Promise<void>} Promise that settles after the task and follow-up scheduling decision.
   * @sideEffect Invokes the configured task and may schedule the next timeout.
   */
  async runCycle() {
    try {
      await this.task();
    } catch (error) {
      this.onError(error);
    } finally {
      this.inFlight = undefined;
      if (this.running) {
        this.scheduleNext();
      }
    }
  }

  /**
   * <summary>
   * Schedules exactly one future cycle after the configured quiet interval.
   * </summary>
   * @returns {void}
   * @sideEffect Creates one timeout.
   */
  scheduleNext() {
    this.timer = this.setTimeoutImpl(this.handleTimer.bind(this), this.intervalMs);
  }

  /**
   * <summary>
   * Handles a scheduled timeout by clearing its handle and starting a cycle only when the poller is still active.
   * </summary>
   * @returns {void}
   * @sideEffect May begin one asynchronous refresh cycle.
   */
  handleTimer() {
    this.timer = undefined;
    if (!this.running || this.inFlight) {
      return;
    }

    this.inFlight = this.runCycle();
  }
}

/**
 * <summary>
 * Provides a no-op default for callers that deliberately handle errors inside their refresh task.
 * </summary>
 * @param {unknown} _error Ignored unexpected polling failure.
 * @returns {void}
 */
function ignorePollingError(_error) {}

module.exports = {
  SourcePoller,
};
