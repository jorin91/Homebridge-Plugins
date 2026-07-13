'use strict';

const {
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_SOURCE_BODY_BYTES,
} = require('../constants');
const { redactSourceUrl } = require('../logging/source-url-redactor');

/**
 * <summary>
 * Represents an HTTP source failure whose message has been deliberately constructed from controlled, redacted
 * values and can therefore cross the transport boundary without exposing the configured source credential.
 * </summary>
 */
class SafeSourceError extends Error {
  /**
   * <summary>
   * Creates a controlled source error with a stable name for diagnostics and tests.
   * </summary>
   * @param {string} message Fully sanitized failure message.
   */
  constructor(message) {
    super(message);
    this.name = 'SafeSourceError';
  }
}

/**
 * <summary>
 * Retrieves a bounded textual source document over HTTP or HTTPS. Transport concerns remain independent from the
 * configured source format, allowing the same polling pipeline to parse JSON now and other representations later.
 * </summary>
 */
class HttpSourceClient {
  /**
   * <summary>
   * Creates an HTTP source client with injectable fetch and safety limits for production and deterministic tests.
   * </summary>
   * @param {object} [options] Optional transport dependencies and safety limits.
   * @param {Function} [options.fetchImpl] Fetch-compatible implementation, normally the Node.js global fetch.
   * @param {number} [options.timeoutMs] Maximum duration of one request in milliseconds.
   * @param {number} [options.maxBodyBytes] Maximum UTF-8 response size accepted in memory.
   */
  constructor({
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    maxBodyBytes = MAX_SOURCE_BODY_BYTES,
  } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('A fetch implementation is required');
    }

    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxBodyBytes = maxBodyBytes;
    this.activeController = undefined;
  }

  /**
   * <summary>
   * Downloads one complete text response after validating its protocol, HTTP status, declared size, and streamed
   * byte count. Errors mention only a redacted source URL so credentials never enter Homebridge logs.
   * </summary>
   * @param {string} source Absolute HTTP or HTTPS source URL.
   * @returns {Promise<string>} Complete bounded response text.
   * @throws {Error} When validation, transport, status, timeout, or response-size checks fail.
   * @sideEffect Performs one network request and temporarily owns an AbortController.
   */
  async readText(source) {
    const sourceUrl = validateSourceUrl(source);
    const safeSource = redactSourceUrl(sourceUrl.toString());
    const controller = new AbortController();
    const timeout = setTimeout(abortController, this.timeoutMs, controller);
    this.activeController = controller;

    try {
      const response = await this.fetchImpl(sourceUrl, {
        headers: {
          accept: '*/*',
        },
        signal: controller.signal,
      });

      if (!response || typeof response.ok !== 'boolean' || !('body' in response)) {
        throw new SafeSourceError(`Source ${safeSource} returned an invalid HTTP response`);
      }

      if (!response.ok) {
        await cancelResponseBody(response.body);
        throw new SafeSourceError(`Source ${safeSource} returned HTTP ${response.status}`);
      }

      const contentLength = readContentLength(response.headers);
      if (contentLength !== undefined && contentLength > this.maxBodyBytes) {
        await cancelResponseBody(response.body);
        throw new SafeSourceError(`Source ${safeSource} exceeds the ${this.maxBodyBytes} byte limit`);
      }

      return await readBoundedResponseText(response.body, this.maxBodyBytes, safeSource);
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new SafeSourceError(`Source ${safeSource} did not respond within ${this.timeoutMs} ms`);
      }

      if (error instanceof SafeSourceError) {
        throw error;
      }

      throw new SafeSourceError(`Unable to read source ${safeSource}`);
    } finally {
      clearTimeout(timeout);
      if (this.activeController === controller) {
        this.activeController = undefined;
      }
    }
  }

  /**
   * <summary>
   * Cancels the currently active request during platform shutdown or runtime replacement. Calling abort when no
   * request is active is safe and has no effect.
   * </summary>
   * @returns {void}
   * @sideEffect Signals cancellation to the active fetch request when one exists.
   */
  abort() {
    if (this.activeController) {
      this.activeController.abort();
    }
  }
}

/**
 * <summary>
 * Aborts a request controller when its timeout expires. This named callback is kept separate so timer behavior is
 * explicit and documentable.
 * </summary>
 * @param {AbortController} controller Controller associated with one active request.
 * @returns {void}
 * @sideEffect Signals request cancellation.
 */
function abortController(controller) {
  controller.abort();
}

/**
 * <summary>
 * Parses and validates an absolute source URL while excluding protocols that fetch should never access for this
 * plugin, including local files and executable schemes.
 * </summary>
 * @param {unknown} source Configured source value.
 * @returns {URL} Validated HTTP or HTTPS URL.
 * @throws {TypeError} When the value is not a valid allowed absolute URL.
 */
function validateSourceUrl(source) {
  let url;

  try {
    url = new URL(String(source));
  } catch {
    throw new TypeError('The configured source must be a valid absolute HTTP or HTTPS URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('The configured source must use HTTP or HTTPS');
  }

  return url;
}

/**
 * <summary>
 * Reads a Fetch response body incrementally and rejects it as soon as its byte count exceeds the configured limit.
 * Node.js Fetch exposes a WHATWG ReadableStream, so no unbounded response.text allocation occurs. A null body, as
 * used by valid bodyless Fetch responses, is represented as an empty string.
 * </summary>
 * @param {ReadableStream<Uint8Array>|null} body Fetch response body.
 * @param {number} maxBodyBytes Maximum number of response bytes permitted in memory.
 * @param {string} safeSource Pre-redacted source label suitable for diagnostics.
 * @returns {Promise<string>} Complete UTF-8 response text when it remains within the limit.
 * @throws {SafeSourceError} When the body is unsupported or exceeds the byte limit.
 * @sideEffect Consumes and locks the response stream for the duration of the read.
 */
async function readBoundedResponseText(body, maxBodyBytes, safeSource) {
  if (body === null) {
    return '';
  }

  if (!body || typeof body.getReader !== 'function') {
    throw new SafeSourceError(`Source ${safeSource} returned an unsupported HTTP response body`);
  }

  const reader = body.getReader();
  const chunks = [];
  let totalBytes = 0;

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }

      const chunkByteLength = readResponseChunkByteLength(result.value);
      if (totalBytes + chunkByteLength > maxBodyBytes) {
        throw new SafeSourceError(`Source ${safeSource} exceeds the ${maxBodyBytes} byte limit`);
      }

      const chunk = normalizeResponseChunk(result.value);
      chunks.push(chunk);
      totalBytes += chunkByteLength;
    }

    return Buffer.concat(chunks, totalBytes).toString('utf8');
  } catch (error) {
    await cancelResponseReader(reader);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Releasing an already detached reader has no cleanup value and must not replace the controlled source error.
    }
  }
}

/**
 * <summary>
 * Determines the byte count of one WHATWG response-stream chunk without copying it. Measuring before allocation lets
 * the caller reject a single oversized transport chunk without duplicating that chunk in plugin-managed memory.
 * </summary>
 * @param {unknown} value Raw chunk returned by ReadableStreamDefaultReader.read.
 * @returns {number} Number of bytes represented by the supported binary chunk.
 * @throws {TypeError} When the transport yields a value that is not a supported binary chunk.
 */
function readResponseChunkByteLength(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return value.byteLength;
  }

  if (value instanceof ArrayBuffer) {
    return value.byteLength;
  }

  throw new TypeError('The HTTP response body returned an unsupported chunk');
}

/**
 * <summary>
 * Converts one WHATWG response-stream chunk into an independently owned Buffer. Copying prevents a transport from
 * mutating or reusing its Uint8Array storage while bounded chunks await final UTF-8 decoding.
 * </summary>
 * @param {unknown} value Raw chunk returned by ReadableStreamDefaultReader.read.
 * @returns {Buffer} Independently owned byte buffer.
 * @throws {TypeError} When the transport yields a value that is not a supported binary chunk.
 */
function normalizeResponseChunk(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value);
  }

  if (value instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(value));
  }

  throw new TypeError('The HTTP response body returned an unsupported chunk');
}

/**
 * <summary>
 * Cancels a locked stream reader after a size failure, decoding failure, or transport interruption so Node Fetch can
 * stop receiving the remaining network body. Cancellation failures are deliberately ignored to preserve the original
 * sanitized source error.
 * </summary>
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader Active response reader.
 * @returns {Promise<void>} Promise that settles after cancellation is attempted.
 * @sideEffect Requests cancellation of the unread response body.
 */
async function cancelResponseReader(reader) {
  try {
    await reader.cancel();
  } catch {
    // The fetch abort signal may already have errored the stream, in which case cancellation is complete in practice.
  }
}

/**
 * <summary>
 * Cancels an unlocked Fetch response body when its Content-Length header already proves it is too large or when the
 * HTTP status is unusable. This avoids downloading a body the client will never consume while keeping cancellation
 * errors out of user-facing logs.
 * </summary>
 * @param {ReadableStream<Uint8Array>|null|undefined} body Fetch response body that has not been locked by a reader.
 * @returns {Promise<void>} Promise that settles after cancellation is attempted or immediately when no body exists.
 * @sideEffect Requests cancellation of the unread response body when supported.
 */
async function cancelResponseBody(body) {
  if (!body || typeof body.cancel !== 'function') {
    return;
  }

  try {
    await body.cancel();
  } catch {
    // A body may already be closed or aborted; the controlled transport diagnostic remains more useful.
  }
}

/**
 * <summary>
 * Reads an optional Content-Length header from Fetch-compatible response headers. Invalid, absent, empty, or negative
 * values are ignored because the streamed body is measured independently while reading.
 * </summary>
 * @param {object} headers Fetch Headers object or compatible test double.
 * @returns {number|undefined} Valid declared byte count or undefined.
 */
function readContentLength(headers) {
  if (!headers || typeof headers.get !== 'function') {
    return undefined;
  }

  const rawValue = headers.get('content-length');
  if (rawValue === null || rawValue === undefined || rawValue === '') {
    return undefined;
  }

  const value = Number(rawValue);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

module.exports = {
  HttpSourceClient,
  SafeSourceError,
  validateSourceUrl,
};
