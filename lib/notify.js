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

export async function notifyNewFlag({ company_name, org_nr, score, flag_reason }) {
  const message = `🚩 Ny flagg: *${company_name}*${org_nr ? ` (${org_nr})` : ''} — score ${score}, skäl: ${flag_reason}`;
  await sendAlert(message);
}
