'use strict';

const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * <summary>
 * Parses JSON source text and resolves configured paths without executing expressions. Supported paths are
 * conventional dot paths with numeric array indexes, such as observations[0].metric.temp, and RFC 6901-style
 * JSON Pointer paths, such as /observations/0/metric/temp.
 * </summary>
 */
class JsonSourceFormat {
  /**
   * <summary>
   * Parses one complete source response as JSON. The caller is responsible for response-size and transport limits.
   * </summary>
   * @param {string} text Complete textual source response.
   * @returns {unknown} Parsed JSON document.
   * @throws {SyntaxError} When the response is not valid JSON.
   */
  parse(text) {
    return JSON.parse(text);
  }

  /**
   * <summary>
   * Validates a configured JSON path before the platform accepts its mapping. Validation also rejects property
   * names that could traverse JavaScript prototype objects.
   * </summary>
   * @param {string} path Configured dot path or JSON Pointer.
   * @returns {void}
   * @throws {TypeError} When the path syntax is invalid or unsafe.
   */
  validatePath(path) {
    parseJsonPath(path);
  }

  /**
   * <summary>
   * Resolves one previously validated path against a parsed JSON document using own properties only. Missing
   * objects, absent properties, and incompatible array indexes return undefined so the mapped unit can publish its
   * neutral fallback.
   * </summary>
   * @param {unknown} document Parsed JSON source document.
   * @param {string} path Configured dot path or JSON Pointer.
   * @returns {unknown} Resolved raw value or undefined when the path cannot be read.
   */
  read(document, path) {
    const segments = parseJsonPath(path);
    let current = document;

    for (const segment of segments) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return undefined;
      }

      if (!Object.prototype.hasOwnProperty.call(current, segment)) {
        return undefined;
      }

      current = current[segment];
    }

    return current;
  }
}

/**
 * <summary>
 * Converts a supported JSON path into immutable property segments. Path syntax is selected solely by the leading
 * slash, allowing future source format handlers to define entirely different path languages without changing
 * mapping or platform code.
 * </summary>
 * @param {unknown} path Candidate JSON path.
 * @returns {ReadonlyArray<string>} Safe immutable path segments.
 * @throws {TypeError} When the path is empty, malformed, or contains a forbidden segment.
 */
function parseJsonPath(path) {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new TypeError('JSON mapping paths must be non-empty strings');
  }

  const normalizedPath = path.trim();
  const segments = normalizedPath.startsWith('/')
    ? parseJsonPointer(normalizedPath)
    : parseDotPath(normalizedPath);

  for (const segment of segments) {
    assertSafeSegment(segment);
  }

  return Object.freeze(segments);
}

/**
 * <summary>
 * Parses a JSON Pointer and decodes the two escape sequences defined by RFC 6901. An empty whole-document pointer
 * is intentionally not accepted because plugin mappings must address an individual source value.
 * </summary>
 * @param {string} path Non-empty JSON Pointer beginning with a slash.
 * @returns {string[]} Decoded pointer segments.
 * @throws {TypeError} When an invalid tilde escape occurs.
 */
function parseJsonPointer(path) {
  return path.slice(1).split('/').map(decodeJsonPointerSegment);
}

/**
 * <summary>
 * Decodes one JSON Pointer segment while rejecting undefined tilde escapes instead of interpreting them loosely.
 * </summary>
 * @param {string} segment Encoded JSON Pointer segment.
 * @returns {string} Decoded property name or array index.
 * @throws {TypeError} When the segment contains an unsupported tilde escape.
 */
function decodeJsonPointerSegment(segment) {
  if (/~(?:[^01]|$)/.test(segment)) {
    throw new TypeError('JSON Pointer paths contain an invalid escape');
  }

  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * <summary>
 * Parses a JavaScript-like dot path with numeric array indexes using a small deterministic grammar. Evaluation,
 * quoted bracket properties, wildcards, filters, and function calls are deliberately unsupported.
 * </summary>
 * @param {string} path Dot path such as observations[0].metric.temp.
 * @returns {string[]} Property and numeric-index segments.
 * @throws {TypeError} When the dot or bracket syntax is invalid.
 */
function parseDotPath(path) {
  const segments = [];
  let cursor = 0;

  while (cursor < path.length) {
    const propertyStart = cursor;

    while (cursor < path.length && path[cursor] !== '.' && path[cursor] !== '[') {
      cursor += 1;
    }

    const property = path.slice(propertyStart, cursor).trim();
    if (property === '') {
      throw new TypeError('JSON dot paths contain an empty property');
    }
    segments.push(property);

    while (cursor < path.length && path[cursor] === '[') {
      const closingBracket = path.indexOf(']', cursor + 1);
      if (closingBracket === -1) {
        throw new TypeError('JSON dot paths contain an unclosed array index');
      }

      const index = path.slice(cursor + 1, closingBracket);
      if (!/^(?:0|[1-9]\d*)$/.test(index)) {
        throw new TypeError('JSON dot paths support only non-negative numeric array indexes');
      }

      segments.push(index);
      cursor = closingBracket + 1;
    }

    if (cursor < path.length) {
      if (path[cursor] !== '.') {
        throw new TypeError('JSON dot paths contain invalid syntax');
      }

      cursor += 1;
      if (cursor >= path.length || path[cursor] === '.' || path[cursor] === '[') {
        throw new TypeError('JSON dot paths contain an empty property');
      }
    }
  }

  return segments;
}

/**
 * <summary>
 * Rejects prototype-related property names before any source document is traversed. This prevents mappings from
 * reaching inherited JavaScript objects even though resolution also requires own properties.
 * </summary>
 * @param {string} segment Decoded path segment.
 * @returns {void}
 * @throws {TypeError} When a segment is empty or could expose a prototype object.
 */
function assertSafeSegment(segment) {
  if (segment === '') {
    throw new TypeError('JSON mapping paths contain an empty segment');
  }

  if (FORBIDDEN_PATH_SEGMENTS.has(segment)) {
    throw new TypeError(`JSON mapping paths cannot contain ${segment}`);
  }
}

module.exports = {
  JsonSourceFormat,
  parseJsonPath,
};
