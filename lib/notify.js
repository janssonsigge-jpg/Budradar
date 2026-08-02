// lib/notify.js
//
// Delad Slack/Discord-webhook-notifierare. Använder samma ALERT_WEBHOOK_URL
// som healthCheck.js redan använder för källfel — en webhook, flera typer
// av notiser.

export async function sendAlert(message) {
  const webhookUrl = process.env.ALERT_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log('[notify] ALERT_WEBHOOK_URL ej satt, hoppar över notis:', message);
    return;
  }
  try {
    // Discord kräver fältet "content". Slack accepterar också "content" numera
    // (och ignorerar det inte), så detta funkar för båda utan att behöva gissa
    // vilken tjänst webhooken pekar mot.
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[notify] Webhook svarade ${res.status}: ${body}`);
    }
  } catch (err) {
    console.error('[notify] Kunde inte skicka webhook:', err.message);
  }
}

export async function notifyNewFlag({ id, company_name, org_nr, score, flag_reason, registered_at, matchedAdvisor, githubCommitSha, githubRepo }) {
  const webhookUrl = process.env.ALERT_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log('[notify] ALERT_WEBHOOK_URL ej satt, hoppar över notis');
    return;
  }

  const reasonReadable = (flag_reason || '').replace(/_/g, ' ').replace(/\+/g, ' · ');

  // Färgkodning efter score: högre score = varmare färg = mer brådskande att kolla
  const color = score >= 80 ? 0xd64545 : score >= 65 ? 0xf5a623 : 0x3b4cff; // röd / orange / blå

  const fields = [
    { name: 'Org.nr', value: org_nr || '—', inline: true },
    { name: 'Score', value: String(score), inline: true },
  ];
  if (matchedAdvisor) fields.push({ name: 'Rådgivare', value: matchedAdvisor, inline: true });
  if (registered_at) fields.push({ name: 'Registrerad', value: registered_at, inline: true });
  fields.push({ name: 'Skäl', value: reasonReadable || '—', inline: false });

  // Länk till den specifika raden i Track Record-tabellen på data.html
  const siteUrl = process.env.SITE_URL || 'https://budradar.vercel.app';
  const flagUrl = id ? `${siteUrl}/data.html#flag-${id}` : `${siteUrl}/data.html`;

  if (githubCommitSha && githubRepo) {
    fields.push({
      name: 'Verifiering',
      value: `[GitHub-commit →](https://github.com/${githubRepo}/commit/${githubCommitSha})`,
      inline: false,
    });
  }

  const embed = {
    title: `🚩 Ny bidco-flagg: ${company_name}`,
    description: `Score **${score}**${matchedAdvisor ? ` · ${matchedAdvisor}` : ''}`,
    color,
    fields,
    url: flagUrl,
    footer: { text: 'BudRadar · Klicka rubriken för att se bolaget på sidan' },
    timestamp: new Date().toISOString(),
  };

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[notify] Webhook svarade ${res.status}: ${body}`);
    }
  } catch (err) {
    console.error('[notify] Kunde inte skicka webhook:', err.message);
  }
}
