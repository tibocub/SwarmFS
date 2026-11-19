/**
 * An error of SwarmFS, with a `code`: `NOT_FOUND`, `EXISTS`, `NOT_AVAILABLE`, `MOVE_INTO_SELF`,
 * `INVALID_NAME`, `INVALID_PARAMS`, `INVALID_TYPE`, `NOT_SUPPORTED`, `IMPORT_INVALID`.
 * Hypergraph's errors (`NOT_ALLOWED`, `INVITE_*`, `RULE_REJECTED`...) pass through as they are.
 */
export class SwarmFSError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor (code, message) {
    super(message)
    this.name = 'SwarmFSError'
    this.code = code
  }
}
