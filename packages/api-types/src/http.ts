// Shared HTTP contract helpers.

/** Error body produced by the backend's global DomainExceptionFilter. */
export interface ApiErrorBody {
  statusCode: number;
  message: string;
  /** Domain error code / class name, when present. */
  error?: string;
  [key: string]: unknown;
}

export interface PaginationParams {
  limit?: number;
  offset?: number;
}

/** Endpoints that wrap rows with a total (e.g. merchant payouts). */
export interface Paginated<T> {
  rows: T[];
  total: number;
}
