export class SwarmFSError extends Error {
  constructor (code, message) {
    super(message)
    this.name = 'SwarmFSError'
    this.code = code
  }
}
