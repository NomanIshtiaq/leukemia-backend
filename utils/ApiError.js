class ApiError extends Error {
  /**
   * @param {number} status   HTTP status code
   * @param {string} message  Message that is safe to show to the client
   * @param {object} [extra]  Optional `{ code, details }`. `code` is a stable,
   *                          machine-readable string (e.g. ACCOUNT_PENDING) the
   *                          app can switch on; `details` is merged into the JSON
   *                          error body. Existing `new ApiError(status, message)`
   *                          calls are unaffected.
   */
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.errorCode = extra.code;
    this.details = extra.details;
  }
}

module.exports = ApiError;
