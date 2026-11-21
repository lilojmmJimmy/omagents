import { RPC_ERROR_CODES } from '@myagents/protocol'

export class AppError extends Error {
  constructor(
    public readonly code: number,
    public readonly reason: string,
    message?: string,
    public readonly details?: unknown
  ) {
    super(message || reason)
    this.name = 'AppError'
  }
}

export const Errors = {
  invalidParams: (msg: string, details?: unknown) =>
    new AppError(RPC_ERROR_CODES.INVALID_PARAMS, 'invalid_params', msg, details),
  notFound: (msg: string) => new AppError(RPC_ERROR_CODES.NOT_FOUND, 'not_found', msg),
  conflict: (reason: string, msg?: string) => new AppError(RPC_ERROR_CODES.CONFLICT, reason, msg ?? reason),
  guardrail: (msg: string) => new AppError(RPC_ERROR_CODES.GUARDRAIL_EXCEEDED, 'guardrail_exceeded', msg),
  busy: (msg: string) => new AppError(RPC_ERROR_CODES.CAPACITY_OR_LOCK_BUSY, 'capacity_or_lock_busy', msg),
  pathOutOfBounds: (msg: string) => new AppError(RPC_ERROR_CODES.PATH_OUT_OF_BOUNDS, 'path_out_of_bounds', msg),
  driverError: (msg: string) => new AppError(RPC_ERROR_CODES.DRIVER_ERROR, 'driver_error', msg),
  reconciling: () =>
    new AppError(RPC_ERROR_CODES.RECONCILING, 'reconciling', 'Core server is still reconciling sessions'),
  unauthorized: (msg = 'Authentication required') => new AppError(RPC_ERROR_CODES.UNAUTHORIZED, 'unauthorized', msg),
  forbidden: (msg = 'Forbidden') => new AppError(RPC_ERROR_CODES.FORBIDDEN, 'forbidden', msg)
}
