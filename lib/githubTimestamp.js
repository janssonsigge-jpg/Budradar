// lib/githubTimestamp.js
//
// Committar varje flagg som en JSON-rad till ett publikt GitHub-repo.
// GitHub-commits har tidsstämplar som är svåra att fejka i efterhand
// (kräver att man rewriter historik och force-pushar, vilket syns
// tydligt i commit-loggen och på tredje parts speglingar/forks).
// Detta ger en oberoende, gratis, publikt verifierbar tidsstämpel
// utanför er egen databas.
//
// SETUP:
// 1. Skapa ett nytt PUBLIKT repo, t.ex. "budradar-track-record"
// 2. Skapa en fil i det: data/flags.jsonl (kan vara tom från start)
// 3. Skapa ett GitHub Personal Access Token (fine-grained, endast
//    "Contents: read and write" på just det repot)
// 4. Lägg till i Vercel env vars:
//    GITHUB_TIMESTAMP_TOKEN=ghp_xxx
//    GITHUB_TIMESTAMP_REPO=dittanvandarnamn/budradar-track-record
//    GITHUB_TIMESTAMP_PATH=data/flags.jsonl
//    GITHUB_TIMESTAMP_BRANCH=main

const GITHUB_API = 'https://api.github.com';

/**
 * Committar en flagg-rad till slutet av JSONL-filen i det publika repot.
 * Returnerar commit SHA, eller null om GitHub-timestamping inte är konfigurerat.
 */
export async function commitFlagToGithub(flagData) {
  const token = process.env.GITHUB_TIMESTAMP_TOKEN;
  const repo = process.env.GITHUB_TIMESTAMP_REPO;
  const path = process.env.GITHUB_TIMESTAMP_PATH || 'data/flags.jsonl';
  const branch = process.env.GITHUB_TIMESTAMP_BRANCH || 'main';

  if (!token || !repo) {
    console.warn('GITHUB_TIMESTAMP_TOKEN/REPO ej konfigurerat — hoppar över extern tidsstämpel');
    return null;
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // 1. Hämta nuvarande filinnehåll + sha (krävs för att uppdatera filen)
  const getUrl = `${GITHUB_API}/repos/${repo}/contents/${path}?ref=${branch}`;
  const getRes = await fetch(getUrl, { headers });

  let currentContent = '';
  let fileSha = undefined;

  if (getRes.status === 200) {
    const fileData = await getRes.json();
    currentContent = Buffer.from(fileData.content, 'base64').toString('utf-8');
    fileSha = fileData.sha;
  } else if (getRes.status !== 404) {
    throw new Error(`GitHub GET misslyckades: ${getRes.status} ${await getRes.text()}`);
  }

  // 2. Lägg till ny rad (JSONL = en JSON-post per rad)
  const newLine = JSON.stringify(flagData);
  const newContent = currentContent.length > 0
    ? `${currentContent.trimEnd()}\n${newLine}\n`
    : `${newLine}\n`;

  const putUrl = `${GITHUB_API}/repos/${repo}/contents/${path}`;
  const putBody = {
    message: `Flag: ${flagData.company_name} (score ${flagData.score}) — id ${flagData.id}`,
    content: Buffer.from(newContent, 'utf-8').toString('base64'),
    branch,
    ...(fileSha ? { sha: fileSha } : {}),
  };

  const putRes = await fetch(putUrl, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(putBody),
  });

  if (!putRes.ok) {
    throw new Error(`GitHub PUT misslyckades: ${putRes.status} ${await putRes.text()}`);
  }

  const putData = await putRes.json();
  return putData.commit?.sha || null;
}
