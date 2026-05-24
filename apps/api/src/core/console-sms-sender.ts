import { Injectable, Logger } from '@nestjs/common';
import type { SmsSender } from '@installment/core';

/**
 * Dev/test SMS sender that logs instead of dispatching. Phase 7 swaps in the
 * real Hubtel/Arkesel clients from @installment/sms-client.
 */
@Injectable()
export class ConsoleSmsSender implements SmsSender {
  private readonly logger = new Logger('SmsSender');

  send(message: { to: string; sender: string; message: string }): Promise<unknown> {
    this.logger.log(`[SMS] to=${message.to} from=${message.sender} :: ${message.message}`);
    return Promise.resolve({ ok: true, simulated: true });
  }
}
