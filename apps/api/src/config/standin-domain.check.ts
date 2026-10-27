import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as dns } from 'node:dns';
import { captureAlert } from '../common/alerting';
import type { Env } from './env.validation';

type ResolveMx = (domain: string) => Promise<{ exchange: string; priority: number }[]>;

/**
 * Whether the stand-in email domain refuses mail, as it must.
 *
 * A customer who signed up with only a phone number has no email, so Paystack
 * is given `<phone>@PAYSTACK_STANDIN_EMAIL_DOMAIN` (see `chargeableEmail`), and
 * Paystack emails receipts to it. That is only safe on a domain Ejua controls
 * that publishes a null MX (`MX 0 .`, RFC 7505): mail to it is refused at once
 * instead of queueing, and nobody else can ever receive it.
 *
 * Two ways it goes wrong, and the reason this exists: a domain nobody has
 * registered — `ejua.gh` was not, when this was written — which anyone can
 * register and then read every customer's payment receipts; and a domain with
 * real MX records, whose mailboxes receive them.
 */
export async function standInDomainProblem(
  domain: string,
  resolveMx: ResolveMx = dns.resolveMx,
): Promise<string | null> {
  let records: { exchange: string; priority: number }[];
  try {
    records = await resolveMx(domain);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOTFOUND') {
      return `${domain} does not exist in DNS. Whoever registers it receives Paystack's emails to customers' stand-in addresses: register it (or choose a domain Ejua owns) and publish "MX 0 .".`;
    }
    if (code === 'ENODATA') {
      return `${domain} has no MX record, so mail falls back to its address record. Publish "MX 0 ." so it is refused.`;
    }
    // A resolver timeout or outage says nothing about the domain.
    return null;
  }
  const isNullMx = records.length === 1 && ['', '.'].includes(records[0]!.exchange);
  if (isNullMx) return null;
  const hosts = records.map((r) => r.exchange).join(', ');
  return `${domain} accepts mail (MX ${hosts}), so Paystack's emails to customers' stand-in addresses are delivered to it. Replace its MX records with "MX 0 .".`;
}

/**
 * Runs the check once the API is up, in production only. It warns rather than
 * refusing to start: DNS is not the deployment's to vouch for, and a resolver
 * blip must not take payments down. Not awaited, for the same reason.
 */
@Injectable()
export class StandInDomainCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger('StandInEmailDomain');

  constructor(private readonly config: ConfigService<Env, true>) {}

  onApplicationBootstrap(): void {
    if (this.config.get('NODE_ENV', { infer: true }) !== 'production') return;
    const domain = this.config.get('PAYSTACK_STANDIN_EMAIL_DOMAIN', { infer: true });
    void standInDomainProblem(domain)
      .then((problem) => {
        if (!problem) return;
        this.logger.warn(problem);
        captureAlert(`PAYSTACK_STANDIN_EMAIL_DOMAIN: ${problem}`, 'warning', { domain });
      })
      .catch(() => undefined);
  }
}
