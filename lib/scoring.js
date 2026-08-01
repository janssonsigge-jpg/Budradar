// lib/scoring.js
//
// Kombinerar signaler från flera källor till en enda score per bolag.
// Filosofi: med ~10 verifierade cases har vi inte data nog för ML,
// så detta är en viktad regelbaserad modell. Poängen är att logga
// ALLA signaler (se signal_log) oavsett om de triggar en flagg, så att
// vi vid 50-70 cases kan bakåt-testa vilka vikter som faktiskt predikerar
// träffar och byta till en tränad modell.
//
// Vikter nedan är startgissningar — justera i takt med backtestet.

import { sql } from './db.js';

const WEIGHTS = {
  BIDCO_SNI_REGISTRATION: 35,      // SNI 64200, nyregistrerat, generiskt namn
  ADVISOR_MATCH: 30,               // firmatecknare/styrelse matchar känd M&A-rådgivare (multipliceras med advisor.weight)
  ADDRESS_MATCH: 20,               // registrerad adress = känd rådgivares kontor
  INSIDER_BUY_SPIKE: 10,           // ovanlig insiderköp-aktivitet i målbolaget
  SHORT_DECREASE_SPIKE: 5,         // snabb minskning av blankningspositioner
};

// Tröskel för att en kombinerad score ska generera en publik flagg.
// Sätt högt initialt — hellre få men trovärdiga flaggor än många brus-flaggor
// (kom ihåg Intrum-lärdomen: en dålig träff i toppen skadar mer än den hjälper).
export const FLAG_THRESHOLD = 55;

/**
 * Matchar ett namn (firmatecknare, styrelseledamot) mot listan över
 * kända M&A-rådgivare i databasen.
 */
async function matchAdvisor(personOrFirmName) {
  if (!personOrFirmName) return null;
  const normalized = personOrFirmName.toLowerCase().trim();

  const { rows } = await sql`SELECT name, type, match_names, known_address, weight FROM known_advisors`;

  for (const advisor of rows) {
    const matches = advisor.match_names.some((alias) => normalized.includes(alias.toLowerCase()));
    if (matches) return advisor;
  }
  return null;
}

/**
 * Matchar en registrerad adress mot kända rådgivares kontorsadresser.
 * Enkel substring-matchning till att börja med — förbättra med
 * normaliserad adressparsing när ni har fler datapunkter.
 */
async function matchAddress(registeredAddress) {
  if (!registeredAddress) return null;
  const normalized = registeredAddress.toLowerCase().trim();

  const { rows } = await sql`
    SELECT name, known_address, weight FROM known_advisors
    WHERE known_address IS NOT NULL
  `;

  for (const advisor of rows) {
    if (advisor.known_address && normalized.includes(advisor.known_address.toLowerCase())) {
      return advisor;
    }
  }
  return null;
}

/**
 * Huvudfunktion: tar in rått signaldata för ETT bolag/bidco-kandidat
 * och returnerar en score + breakdown + ev. matchade rådgivare.
 *
 * @param {object} input
 * @param {boolean} input.isBidcoSniRegistration - SNI 64200, nytt org.nr, generiskt namn
 * @param {string}  [input.signatoryName] - namn på firmatecknare/styrelseledamot att matcha mot rådgivare
 * @param {string}  [input.registeredAddress] - bidcots registrerade adress
 * @param {boolean} [input.insiderBuySpike] - ovanlig insiderköp-aktivitet detekterad
 * @param {boolean} [input.shortDecreaseSpike] - snabb minskning i blankning detekterad
 */
export async function scoreCompany(input) {
  const breakdown = [];
  let score = 0;

  if (input.isBidcoSniRegistration) {
    score += WEIGHTS.BIDCO_SNI_REGISTRATION;
    breakdown.push({ signal: 'bidco_sni_registration', points: WEIGHTS.BIDCO_SNI_REGISTRATION });
  }

  let matchedAdvisor = null;
  if (input.signatoryName) {
    matchedAdvisor = await matchAdvisor(input.signatoryName);
    if (matchedAdvisor) {
      const pts = WEIGHTS.ADVISOR_MATCH * Number(matchedAdvisor.weight);
      score += pts;
      breakdown.push({ signal: 'advisor_match', advisor: matchedAdvisor.name, points: pts });
    }
  }

  let matchedAddress = null;
  if (input.registeredAddress) {
    matchedAddress = await matchAddress(input.registeredAddress);
    if (matchedAddress) {
      const pts = WEIGHTS.ADDRESS_MATCH * Number(matchedAddress.weight);
      score += pts;
      breakdown.push({ signal: 'address_match', advisor: matchedAddress.name, points: pts });
    }
  }

  if (input.insiderBuySpike) {
    score += WEIGHTS.INSIDER_BUY_SPIKE;
    breakdown.push({ signal: 'insider_buy_spike', points: WEIGHTS.INSIDER_BUY_SPIKE });
  }

  if (input.shortDecreaseSpike) {
    score += WEIGHTS.SHORT_DECREASE_SPIKE;
    breakdown.push({ signal: 'short_decrease_spike', points: WEIGHTS.SHORT_DECREASE_SPIKE });
  }

  return {
    score: Math.round(score * 100) / 100,
    shouldFlag: score >= FLAG_THRESHOLD,
    breakdown,
    matchedAdvisor: matchedAdvisor?.name || null,
    matchedAddress: matchedAddress?.name || null,
  };
}
