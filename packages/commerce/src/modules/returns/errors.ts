export class ReturnNotFoundError extends Error {
  constructor(id: string) {
    super(`Return "${id}" not found`);
    this.name = 'ReturnNotFoundError';
  }
}

export class OrderNotReturnableError extends Error {
  constructor(orderId: string, why: string) {
    super(`Order "${orderId}" cannot be returned: ${why}`);
    this.name = 'OrderNotReturnableError';
  }
}

export class ReturnAlreadyOpenError extends Error {
  constructor(orderId: string) {
    super(`Order "${orderId}" already has a return waiting on a decision`);
    this.name = 'ReturnAlreadyOpenError';
  }
}

export class ReturnAlreadyDecidedError extends Error {
  constructor(id: string, status: string) {
    super(`Return "${id}" is already "${status}"`);
    this.name = 'ReturnAlreadyDecidedError';
  }
}

export class ReturnWindowClosedError extends Error {
  constructor(orderId: string, endedAt: string) {
    super(`The return window for order "${orderId}" closed on ${endedAt}`);
    this.name = 'ReturnWindowClosedError';
  }
}
