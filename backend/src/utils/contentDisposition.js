/**
 * Content-Disposition helpers.
 * @module utils/contentDisposition
 * @description Builds a header-safe `Content-Disposition` value for a file
 * download. Shared by every endpoint that streams a stored or generated file so
 * the escaping rules live in exactly one place.
 */

/**
 * Builds a `Content-Disposition` value that is always header-safe.
 *
 * Only stripping quotes/backslashes is not enough: a name containing any
 * non-Latin-1 character (for example the em dash in
 * "Anecdotal Report — September 2026") makes `res.setHeader` throw
 * `Invalid character in header content` and turns a valid download into a 500.
 * The ASCII form is kept for older clients and the real name is carried in the
 * RFC 6266 `filename*` parameter.
 *
 * @param {string} name           Preferred file name.
 * @param {'inline'|'attachment'} [disposition]
 * @returns {string}
 */
function contentDisposition(name, disposition = 'inline') {
  const cleaned = String(name || 'document').replace(/["\\\r\n]/g, '_');
  const ascii = cleaned.replace(/[^\x20-\x7E]/g, '_');
  const encoded = encodeURIComponent(cleaned)
    .replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

module.exports = { contentDisposition };
