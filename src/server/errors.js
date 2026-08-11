/**
 * Async handler wrapper.
 *
 * Without this, a rejected promise inside a route reaches the host's error
 * handler — or Express's default one, which answers **HTML**. Every route in
 * this package answers JSON, including on failure, so a client that only knows
 * how to parse `{ error }` never has to special-case a 500.
 *
 * Test it by injecting a model whose method throws. See standards/traps.md #6.
 */
export function wrap(logger, handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (err) {
      logger.error?.({ err, path: req.originalUrl }, 'telemetry: request failed');
      // Headers already flushed means we're mid-response — nothing useful left
      // to say, hand it to the host's handler to close out.
      if (res.headersSent) return next(err);
      res.status(500).json({ error: 'internal_error' });
    }
  };
}

/**
 * A failure the caller caused, answered as itself rather than as a 500.
 *
 *   throw new HttpError(404, 'not_found');
 */
export class HttpError extends Error {
  constructor(status, code, details) {
    super(code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Variant of `wrap` that honors HttpError instead of flattening them to 500. */
export function wrapWithHttpErrors(logger, handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (err) {
      if (err instanceof HttpError) {
        if (res.headersSent) return next(err);
        return res.status(err.status).json({ error: err.code, ...(err.details ?? {}) });
      }
      logger.error?.({ err, path: req.originalUrl }, 'telemetry: request failed');
      if (res.headersSent) return next(err);
      res.status(500).json({ error: 'internal_error' });
    }
  };
}
