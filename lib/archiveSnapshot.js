// lib/archiveSnapshot.js
//
// Sparar rådata från varje daglig hämtning INNAN den processas.
// Kräver: npm install @vercel/blob
// Syfte: om er parsing-logik har en bugg (t.ex. FI byter CSV-encoding,
// eller ni missar ett fält) vill ni kunna köra om historiken från rådata
// istället för att ha förlorat den för alltid.

import { put } from '@vercel/blob';

/**
 * Arkiverar rå data (sträng eller buffer) till Vercel Blob innan processning.
 * @param {string} source - 'bolagsverket' | 'fi_insider' | 'fi_short' | 'mfn'
 * @param {string|Buffer} rawData
 * @param {string} [extension] - t.ex. 'csv', 'ods', 'json'
 */
export async function archiveRawSnapshot(source, rawData, extension = 'json') {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const pathname = `raw-snapshots/${source}/${timestamp}.${extension}`;

  const blob = await put(pathname, rawData, {
    access: 'public', // sätt 'private' om ni vill hålla rådatan intern (kräver token för läsning)
    addRandomSuffix: false,
  });

  return blob.url;
}

/**
 * Hjälpfunktion för att generera ett unikt run_id per dag och källa,
 * används för idempotens i signal_log (se sql/001_*.sql UNIQUE-index).
 */
export function todaysRunId() {
  const d = new Date();
  return `daily-${d.toISOString().slice(0, 10)}`; // t.ex. 'daily-2026-08-01'
}
