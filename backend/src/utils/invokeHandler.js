/**
 * Run an Express handler in-process and resolve with what it sent.
 *
 * Lets one endpoint reuse another's full behaviour — the Education upload files
 * its document through `documentController.create` itself, so the folder,
 * admission, approval, revision history and notifications are exactly those of
 * any other upload rather than a copy of them that could drift.
 *
 * Resolves `{ status, body }`; rejects with whatever the handler passed to
 * `next` (an ApiError keeps its status).
 *
 * @module utils/invokeHandler
 */
function invokeHandler(handler, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      setHeader() { return this; },
      json(body) { resolve({ status: this.statusCode, body }); return this; },
    };
    Promise.resolve(handler(req, res, (error) => (error ? reject(error) : resolve({ status: res.statusCode, body: null }))))
      .catch(reject);
  });
}

module.exports = { invokeHandler };
