import { Platform } from 'react-native';
import type { AuthContextValue } from '@installment/mobile-kit';
import { File, Paths } from 'expo-file-system';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

/** The app's authenticated client. */
type Api = AuthContextValue['api'];

export type StatementFormat = 'csv' | 'html';

export interface StatementDocument {
  /** The route without its extension: `/merchant/statement`, `/merchant/plans/<id>/statement`. */
  path: string;
  params?: Record<string, string | number>;
  /** File name without extension: `ejua-statement-2026-11`. */
  filename: string;
}

/**
 * Gets a statement out of the app: a CSV for a spreadsheet or an accountant,
 * or the printable page.
 *
 * The routes need the seller's bearer token, so neither can be a plain link a
 * browser or the OS opens by itself; the document is fetched as text first.
 * Then it goes where each platform keeps files:
 *
 * - **Web:** the CSV downloads; the printable page opens in a new tab, to print
 *   or save as PDF from the browser — as the web portal this replaces did.
 * - **Phone:** the CSV is written to the cache and handed to the share sheet
 *   (save to Files, mail it, send it on WhatsApp); the printable page goes to
 *   the system print dialog, which can also save a PDF.
 */
export async function exportStatement(
  api: Api,
  doc: StatementDocument,
  format: StatementFormat,
): Promise<void> {
  const { data: text } = await api.get<string>(`${doc.path}.${format}`, {
    params: doc.params,
    responseType: 'text',
  });

  if (Platform.OS === 'web') {
    const url = URL.createObjectURL(
      new Blob([text], { type: format === 'csv' ? 'text/csv' : 'text/html' }),
    );
    if (format === 'csv') {
      const link = document.createElement('a');
      link.href = url;
      link.download = `${doc.filename}.csv`;
      link.click();
    } else {
      window.open(url, '_blank', 'noopener');
    }
    // Long enough for the download or the new tab to have read it.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return;
  }

  if (format === 'html') {
    await Print.printAsync({ html: text });
    return;
  }

  const file = new File(Paths.cache, `${doc.filename}.csv`);
  file.create({ overwrite: true });
  file.write(text);
  await Sharing.shareAsync(file.uri, {
    mimeType: 'text/csv',
    UTI: 'public.comma-separated-values-text',
    dialogTitle: 'Share your statement',
  });
}
