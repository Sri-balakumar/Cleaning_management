// The SDK 54 File API's write() takes a string or a Uint8Array, so putting
// base64 through it means decoding by hand - and getting that wrong writes a
// text file with a .pdf name. The legacy helper does exactly this one job.
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Sharing from 'expo-sharing';

import { AppError } from '../api/errors';
import { fetchManual } from '../api/manual';
import { log } from './log';

/** Keep a filename usable as a filename, whatever was typed in the backend. */
const safeName = (name) => String(name || 'manual.pdf').replace(/[^\w.\- ]+/g, '_');

/**
 * "%PDF-" at the head of the file, read straight from the base64.
 *
 * The first six characters cover the first four bytes and part of the fifth,
 * which is enough: nothing else encodes to `JVBERi` at the front. Decoding the
 * whole document to check five bytes would mean holding megabytes in memory to
 * learn nothing more.
 */
const looksLikePdf = (base64) => typeof base64 === 'string' && base64.startsWith('JVBERi');

/**
 * Fetch one document and hand it to whatever opens PDFs on this phone.
 *
 * Shared by the Help shelf and the guide screen, so a document opens the same
 * way whichever of the two asked for it.
 *
 * Handing the browser a URL is not an option: it has no session cookie, so the
 * server would refuse. The bytes come over the same authenticated channel as
 * everything else, and are written to the cache before the system chooser sees
 * them.
 */
export async function openManualPdf(baseUrl, manualId) {
  const doc = await fetchManual(baseUrl, manualId);
  if (!doc?.data) throw new AppError('server');

  // The server refuses anything that is not a PDF on upload; this is the same
  // rule at the other end, so a document that slipped in before the rule
  // existed fails with a sentence rather than a viewer's own error.
  if (!looksLikePdf(doc.data)) throw new AppError('not_a_pdf');

  const uri = `${FileSystem.cacheDirectory}${safeName(doc.filename)}`;
  await FileSystem.writeAsStringAsync(uri, doc.data, { encoding: 'base64' });

  // Android: hand the file to whatever reads PDFs, and let the system offer the
  // choice. The share sheet used before answers a different question -- it asks
  // who to SEND this to, which is why a manual came up offering WhatsApp and
  // Drive ahead of anything that could actually display it.
  //
  // A content:// URI is required: another app cannot read this one's cache
  // directory, and flag 1 (FLAG_GRANT_READ_URI_PERMISSION) is what lends it
  // read access for the life of the intent.
  if (Platform.OS === 'android') {
    const contentUri = await FileSystem.getContentUriAsync(uri);
    await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      data: contentUri,
      flags: 1,
      type: 'application/pdf',
    });
    log('manual', 'opened', { id: manualId, filename: doc.filename, via: 'intent' });
    return;
  }

  // iOS has no "open with" of its own; the share sheet IS how a file reaches
  // another app there, and it lists the readers under "Open in".
  if (!(await Sharing.isAvailableAsync())) throw new AppError('server');
  await Sharing.shareAsync(uri, {
    mimeType: 'application/pdf',
    UTI: 'com.adobe.pdf',
    dialogTitle: doc.name,
  });
  log('manual', 'opened', { id: manualId, filename: doc.filename, via: 'share' });
}
