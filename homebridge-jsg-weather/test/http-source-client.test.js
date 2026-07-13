'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { redactSourceUrl } = require('../lib/logging/source-url-redactor');
const { HttpSourceClient } = require('../lib/sources/http-source-client');

/**
 * <summary>
 * Represents Fetch-compatible response headers for isolated HTTP client tests.
 * </summary>
 */
class TestHeaders {
  /**
   * <summary>
   * Creates a header collection with an optional declared content length.
   * </summary>
   * @param {string|undefined} contentLength Optional Content-Length header value.
   */
  constructor(contentLength = undefined) {
    this.contentLength = contentLength;
  }

  /**
   * <summary>
   * Returns the configured Content-Length value and treats every other header as absent.
   * </summary>
   * @param {string} name Requested header name.
   * @returns {string|null} Header value or null when absent.
   */
  get(name) {
    return name.toLowerCase() === 'content-length' && this.contentLength !== undefined
      ? this.contentLength
      : null;
  }
}

/**
 * <summary>
 * Creates a one-chunk WHATWG response body so the test double follows the same incremental read path as Node Fetch.
 * </summary>
 * @param {string} text Text to encode as UTF-8 response bytes.
 * @returns {ReadableStream<Uint8Array>} Closed stream containing the encoded text.
 */
function createTextResponseBody(text) {
  const bytes = Buffer.from(text, 'utf8');

  /**
   * <summary>
   * Enqueues the configured bytes and closes the synthetic response stream.
   * </summary>
   * @param {ReadableStreamDefaultController<Uint8Array>} controller Synthetic stream controller.
   * @returns {void}
   * @sideEffect Populates and closes the synthetic stream.
   */
  function start(controller) {
    controller.enqueue(bytes);
    controller.close();
  }

  return new ReadableStream({ start });
}

/**
 * <summary>
 * Creates a tracked multi-chunk response body with disabled prefetching. Tests can therefore prove that an oversized
 * response is canceled immediately and that later chunks are never requested or accumulated.
 * </summary>
 * @param {string[]} values Ordered UTF-8 chunk contents.
 * @param {object} state Mutable observation state shared with the test.
 * @param {number} state.pullCalls Number of chunks requested from the body.
 * @param {number} state.cancelCalls Number of body-cancellation requests.
 * @returns {ReadableStream<Uint8Array>} Incremental tracked response stream.
 * @sideEffect Updates the supplied observation state as the stream is read and canceled.
 */
function createTrackedChunkedBody(values, state) {
  const chunks = values.map((value) => Buffer.from(value, 'utf8'));
  let nextChunkIndex = 0;

  /**
   * <summary>
   * Delivers exactly one requested chunk, or closes the stream after the final chunk.
   * </summary>
   * @param {ReadableStreamDefaultController<Uint8Array>} controller Synthetic stream controller.
   * @returns {void}
   * @sideEffect Advances the chunk cursor and increments the observable pull count.
   */
  function pull(controller) {
    state.pullCalls += 1;

    if (nextChunkIndex >= chunks.length) {
      controller.close();
      return;
    }

    controller.enqueue(chunks[nextChunkIndex]);
    nextChunkIndex += 1;
  }

  /**
   * <summary>
   * Records that the consumer stopped the body before all chunks were requested.
   * </summary>
   * @returns {void}
   * @sideEffect Increments the observable cancellation count.
   */
  function cancel() {
    state.cancelCalls += 1;
  }

  return new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
}

/**
 * <summary>
 * Creates a response stream that remains pending until the Fetch request signal aborts it. This mirrors the behavior
 * of a Node Fetch body whose server stalls after returning response headers.
 * </summary>
 * @param {AbortSignal} signal Fetch request cancellation signal.
 * @returns {ReadableStream<Uint8Array>} Pending stream that errors with AbortError after cancellation.
 */
function createAbortableResponseBody(signal) {
  /**
   * <summary>
   * Connects the synthetic stream lifecycle to the request abort signal.
   * </summary>
   * @param {ReadableStreamDefaultController<Uint8Array>} controller Synthetic stream controller.
   * @returns {void}
   * @sideEffect Registers a one-time abort listener and errors the stream when cancellation occurs.
   */
  function start(controller) {
    /**
     * <summary>
     * Errors the pending stream using the same error name produced by an aborted Node Fetch body.
     * </summary>
     * @returns {void}
     * @sideEffect Rejects any pending response-body read.
     */
    function abortStream() {
      const error = new Error('Synthetic response body aborted');
      error.name = 'AbortError';
      controller.error(error);
    }

    if (signal.aborted) {
      abortStream();
      return;
    }

    signal.addEventListener('abort', abortStream, { once: true });
  }

  return new ReadableStream({ start });
}

/**
 * <summary>
 * Creates a minimal Fetch-compatible response with a WHATWG response body.
 * </summary>
 * @param {object} options Response values.
 * @param {boolean} options.ok Whether the status is successful.
 * @param {number} options.status HTTP status code.
 * @param {string} options.body Text response body used when no custom stream is supplied.
 * @param {string|undefined} [options.contentLength] Optional declared body length.
 * @param {ReadableStream<Uint8Array>|null|undefined} [options.responseBody] Optional custom response stream.
 * @returns {object} Fetch-compatible response double.
 */
function createResponse({
  ok,
  status,
  body,
  contentLength = undefined,
  responseBody = undefined,
}) {
  return {
    ok,
    status,
    headers: new TestHeaders(contentLength),
    body: responseBody === undefined ? createTextResponseBody(body) : responseBody,
  };
}

/**
 * <summary>
 * Verifies likely credential query parameters are redacted without hiding an ordinary generic selector.
 * </summary>
 * @returns {void}
 */
function sourceUrlRedactionMasksCredentials() {
  const redacted = redactSourceUrl(
    'https://api.example.test/current?location=TEST_LOCATION&apiKey=example-secret&token=example-token',
  );

  assert.match(redacted, /^https:\/\/api\.example\.test\/current\?/);
  assert.match(redacted, /location=TEST_LOCATION/);
  assert.match(redacted, /redacted/i);
  assert.equal(redacted.includes('example-secret'), false);
  assert.equal(redacted.includes('example-token'), false);
  assert.equal(redactSourceUrl('not a URL'), '[invalid source URL]');
}

/**
 * <summary>
 * Verifies OpenWeather-style appid credentials and common user, password, and token key variants are all masked.
 * </summary>
 * @returns {void}
 */
function sourceUrlRedactionMasksAppIdAndCredentialVariants() {
  const redacted = redactSourceUrl(
    'https://api.example.test/current?location=almelo&appid=appid-secret&user_name=user-secret&passwd=password-secret&refresh_token=refresh-secret',
  );

  assert.match(redacted, /location=almelo/);
  assert.equal(redacted.includes('appid-secret'), false);
  assert.equal(redacted.includes('user-secret'), false);
  assert.equal(redacted.includes('password-secret'), false);
  assert.equal(redacted.includes('refresh-secret'), false);
  assert.equal((redacted.match(/redacted/gi) || []).length, 4);
}

/**
 * <summary>
 * Verifies username and password credentials embedded in the URL authority are removed rather than serialized.
 * </summary>
 * @returns {void}
 */
function sourceUrlRedactionRemovesAuthorityCredentials() {
  const redacted = redactSourceUrl(
    'https://weather-user:authority-secret@api.example.test/current?location=almelo',
  );
  const parsed = new URL(redacted);

  assert.equal(parsed.username, '');
  assert.equal(parsed.password, '');
  assert.equal(redacted.includes('weather-user'), false);
  assert.equal(redacted.includes('authority-secret'), false);
  assert.equal(redacted, 'https://api.example.test/current?location=almelo');
}

/**
 * <summary>
 * Verifies successful text retrieval uses the validated URL, Accept header, and request cancellation signal.
 * </summary>
 * @returns {Promise<void>} Promise that settles after the source request assertion.
 */
async function httpSourceClientReadsSuccessfulResponse() {
  let requestedUrl;
  let requestOptions;

  /**
   * <summary>
   * Captures one Fetch request and returns a successful JSON response.
   * </summary>
   * @param {URL} url Validated source URL.
   * @param {object} options Fetch request options.
   * @returns {Promise<object>} Successful response double.
   */
  async function fetchSuccessfulResponse(url, options) {
    requestedUrl = url;
    requestOptions = options;
    return createResponse({ ok: true, status: 200, body: '{"value":18}' });
  }

  const client = new HttpSourceClient({ fetchImpl: fetchSuccessfulResponse, timeoutMs: 1000 });
  const result = await client.readText('https://api.example.test/current?location=example');

  assert.equal(result, '{"value":18}');
  assert.equal(requestedUrl.toString(), 'https://api.example.test/current?location=example');
  assert.equal(requestOptions.headers.accept, '*/*');
  assert.equal(requestOptions.signal instanceof AbortSignal, true);
  assert.equal(client.activeController, undefined);
}

/**
 * <summary>
 * Verifies non-success statuses reject safely and never expose authority or query-based credentials in the error.
 * </summary>
 * @returns {Promise<void>} Promise that settles after the rejection assertions.
 */
async function httpSourceClientRejectsHttpStatusSafely() {
  /**
   * <summary>
   * Returns a provider authorization failure response.
   * </summary>
   * @returns {Promise<object>} Failed response double.
   */
  async function fetchUnauthorizedResponse() {
    return createResponse({ ok: false, status: 401, body: 'unauthorized' });
  }

  const client = new HttpSourceClient({ fetchImpl: fetchUnauthorizedResponse, timeoutMs: 1000 });
  const source = 'https://weather-user:authority-secret@api.example.test/current?appid=query-secret';

  await assert.rejects(client.readText(source), /returned HTTP 401/);

  try {
    await client.readText(source);
    assert.fail('Expected the request to reject');
  } catch (error) {
    assert.equal(error.message.includes('weather-user'), false);
    assert.equal(error.message.includes('authority-secret'), false);
    assert.equal(error.message.includes('query-secret'), false);
    assert.match(error.message, /redacted/i);
  }
}

/**
 * <summary>
 * Verifies both declared and incrementally measured response sizes are bounded before data reaches a source parser.
 * </summary>
 * @returns {Promise<void>} Promise that settles after both size-limit assertions.
 */
async function httpSourceClientEnforcesResponseSizeLimit() {
  /**
   * <summary>
   * Returns a response whose header declares a body larger than the configured limit.
   * </summary>
   * @returns {Promise<object>} Oversized declared response double.
   */
  async function fetchDeclaredOversizedResponse() {
    return createResponse({ ok: true, status: 200, body: 'small', contentLength: '11' });
  }

  /**
   * <summary>
   * Returns a response whose actual UTF-8 body exceeds the configured limit.
   * </summary>
   * @returns {Promise<object>} Oversized measured response double.
   */
  async function fetchMeasuredOversizedResponse() {
    return createResponse({ ok: true, status: 200, body: '12345678901' });
  }

  const declaredClient = new HttpSourceClient({
    fetchImpl: fetchDeclaredOversizedResponse,
    timeoutMs: 1000,
    maxBodyBytes: 10,
  });
  const measuredClient = new HttpSourceClient({
    fetchImpl: fetchMeasuredOversizedResponse,
    timeoutMs: 1000,
    maxBodyBytes: 10,
  });

  await assert.rejects(
    declaredClient.readText('https://api.example.test/weather'),
    /exceeds the 10 byte limit/,
  );
  await assert.rejects(
    measuredClient.readText('https://api.example.test/weather'),
    /exceeds the 10 byte limit/,
  );
}

/**
 * <summary>
 * Verifies a chunked body is canceled on the first chunk crossing the limit without requesting later chunks.
 * </summary>
 * @returns {Promise<void>} Promise that settles after the early-cancellation assertions.
 */
async function httpSourceClientStopsReadingChunkedOversizedBody() {
  const streamState = {
    pullCalls: 0,
    cancelCalls: 0,
  };
  const responseBody = createTrackedChunkedBody(
    ['123456', '789012', 'this-chunk-must-never-be-read'],
    streamState,
  );

  /**
   * <summary>
   * Returns the tracked chunked body without a Content-Length header.
   * </summary>
   * @returns {Promise<object>} Chunked response double.
   */
  async function fetchChunkedOversizedResponse() {
    return createResponse({
      ok: true,
      status: 200,
      body: '',
      responseBody,
    });
  }

  const client = new HttpSourceClient({
    fetchImpl: fetchChunkedOversizedResponse,
    timeoutMs: 1000,
    maxBodyBytes: 10,
  });

  await assert.rejects(
    client.readText('https://api.example.test/chunked'),
    /exceeds the 10 byte limit/,
  );
  assert.equal(streamState.pullCalls, 2);
  assert.equal(streamState.cancelCalls, 1);
}

/**
 * <summary>
 * Verifies the request timeout continues to abort a response that stalls while its Node-style body is being read.
 * </summary>
 * @returns {Promise<void>} Promise that settles after the streaming-timeout assertion.
 */
async function httpSourceClientTimesOutWhileReadingResponseBody() {
  /**
   * <summary>
   * Returns a successful response whose body waits for the supplied abort signal indefinitely.
   * </summary>
   * @param {URL} _url Validated source URL, unused by this controlled response.
   * @param {object} options Fetch request options containing the cancellation signal.
   * @returns {Promise<object>} Stalled response double.
   */
  async function fetchStalledResponse(_url, options) {
    return createResponse({
      ok: true,
      status: 200,
      body: '',
      responseBody: createAbortableResponseBody(options.signal),
    });
  }

  const client = new HttpSourceClient({ fetchImpl: fetchStalledResponse, timeoutMs: 20 });

  await assert.rejects(
    client.readText('https://api.example.test/stalled'),
    /did not respond within 20 ms/,
  );
  assert.equal(client.activeController, undefined);
}

/**
 * <summary>
 * Verifies non-HTTP protocols are rejected before the injected transport is called.
 * </summary>
 * @returns {Promise<void>} Promise that settles after protocol validation.
 */
async function httpSourceClientRejectsUnsupportedProtocols() {
  let fetchCalls = 0;

  /**
   * <summary>
   * Records an unexpected request if protocol validation fails to stop it.
   * </summary>
   * @returns {Promise<object>} Successful response double that should not be used.
   * @sideEffect Increments the transport call counter.
   */
  async function recordUnexpectedFetch() {
    fetchCalls += 1;
    return createResponse({ ok: true, status: 200, body: 'unused' });
  }

  const client = new HttpSourceClient({ fetchImpl: recordUnexpectedFetch, timeoutMs: 1000 });

  await assert.rejects(client.readText('file:///tmp/weather.json'), /must use HTTP or HTTPS/);
  await assert.rejects(client.readText('javascript:alert(1)'), /must use HTTP or HTTPS/);
  assert.equal(fetchCalls, 0);
}

test('source URL redaction masks likely query credentials', sourceUrlRedactionMasksCredentials);
test('source URL redaction masks appid and credential-key variants', sourceUrlRedactionMasksAppIdAndCredentialVariants);
test('source URL redaction removes authority credentials', sourceUrlRedactionRemovesAuthorityCredentials);
test('HTTP source client returns successful bounded response text', httpSourceClientReadsSuccessfulResponse);
test('HTTP source client reports failed status without exposing credentials', httpSourceClientRejectsHttpStatusSafely);
test('HTTP source client enforces declared and measured response limits', httpSourceClientEnforcesResponseSizeLimit);
test('HTTP source client stops reading an oversized chunked body early', httpSourceClientStopsReadingChunkedOversizedBody);
test('HTTP source client times out while reading a stalled response body', httpSourceClientTimesOutWhileReadingResponseBody);
test('HTTP source client rejects non-HTTP protocols before transport', httpSourceClientRejectsUnsupportedProtocols);
