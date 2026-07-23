const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const LOGO_URL = 'https://iclora.app/pwa-icon-512.png';
const MANAGE_ACCOUNT_URL = 'https://iclora.app/cloud/manage-account';
const alertRateBuckets = new Map();

function allowAlertSend(key, { limit = 5, windowMs = 10 * 60 * 1000 } = {}) {
  if (!key) return false;

  const now = Date.now();
  const bucket = alertRateBuckets.get(key) || [];
  const recent = bucket.filter((timestamp) => now - timestamp < windowMs);
  if (recent.length >= limit) {
    alertRateBuckets.set(key, recent);
    return false;
  }

  recent.push(now);
  alertRateBuckets.set(key, recent);
  return true;
}

function cleanText(value = '', fallback = '') {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function escapeHtml(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function displayProvider(provider = '') {
  const value = cleanText(provider, 'iClora');
  if (value === 'password') return 'Password';
  if (value === 'google.com') return 'Google';
  if (value === 'passkey') return 'Passkey';
  if (value === 'firebase') return 'Google';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value?.toDate === 'function') return value.toDate();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDateTime(value) {
  const date = toDate(value);
  if (!date) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'Asia/Kolkata',
    }).format(date).replace(/\b(am|pm)\b/i, (match) => match.toLowerCase());
  } catch {
    return date.toISOString();
  }
}

function getResendApiKey() {
  return process.env.RESEND_API || process.env.RESEND_API_KEY || '';
}

function getFromAddress() {
  return process.env.RESEND_FROM || process.env.ALERT_EMAIL_FROM || 'iClora <alerts@iclora.app>';
}

function getReplyTo() {
  return process.env.RESEND_REPLY_TO || process.env.ALERT_EMAIL_REPLY_TO || '';
}

function isMailEnabled() {
  return Boolean(getResendApiKey() && getFromAddress());
}

function renderDetailRows(details = []) {
  return details
    .filter((item) => item?.value)
    .map((item) => `
      <tr>
        <td style="padding:12px 0;border-bottom:1px solid rgba(120,120,128,.18);color:#6b7280;font:600 13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">${escapeHtml(item.label)}</td>
        <td style="padding:12px 0;border-bottom:1px solid rgba(120,120,128,.18);color:#111827;font:700 14px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-align:right;">${item.label === 'Name' ? renderGradientName(item.value, '14px') : escapeHtml(item.value)}</td>
      </tr>
    `)
    .join('');
}

function renderTextDetails(details = []) {
  return details
    .filter((item) => item?.value)
    .map((item) => `${item.label}: ${item.value}`)
    .join('\n');
}

function getLocationLabel(session = {}) {
  const label = cleanText(session?.locationLabel);
  if (label) return label;

  return [
    cleanText(session?.locationCity),
    cleanText(session?.locationRegion),
    cleanText(session?.locationCountry),
  ].filter(Boolean).join(', ');
}

function renderGradientName(value = '', fontSize = '16px') {
  return `<span style="display:inline-block;color:#60a5fa;background:linear-gradient(90deg,#7dd3fc 0%,#60a5fa 34%,#6366f1 68%,#a855f7 100%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;font:800 ${fontSize} -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">${escapeHtml(value)}</span>`;
}

function getDisplayName(user = {}) {
  const joinedName = [user?.firstName, user?.middleName, user?.lastName]
    .map((part) => cleanText(part))
    .filter(Boolean)
    .join(' ');

  return cleanText(
    user?.name
      || user?.displayName
      || user?.fullName
      || joinedName
      || user?.providerName
  );
}

function getProfilePhotoUrl(user = {}) {
  return cleanText(
    user?.profilePhotoUrl
      || user?.profilePhoto?.url
      || user?.photoURL
      || user?.picture
      || user?.avatar
  );
}

function renderIdentityBlock({ name = '', email = '', profilePhotoUrl = '' } = {}) {
  const displayName = cleanText(name, 'iClora user');
  const displayEmail = cleanText(email);
  const photoUrl = cleanText(profilePhotoUrl);

  if (!displayName && !displayEmail && !photoUrl) return '';

  const avatar = photoUrl
    ? `<img src="${escapeHtml(photoUrl)}" width="54" height="54" alt="" style="display:block;width:54px;height:54px;border-radius:50%;object-fit:cover;border:1px solid rgba(120,120,128,.24);background:transparent;">`
    : `<span style="display:block;width:54px;height:54px;border-radius:50%;background:#e5f1ff;color:#0071e3;text-align:center;font:800 22px/54px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">${escapeHtml(displayName.charAt(0).toUpperCase() || 'i')}</span>`;

  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:18px 0 0;border-collapse:collapse;">
      <tr>
        <td width="62" style="padding:0 12px 0 0;vertical-align:middle;">${avatar}</td>
        <td style="padding:0;vertical-align:middle;text-align:left;">
          <div class="identity-name">${renderGradientName(displayName)}</div>
          ${displayEmail ? `<div class="identity-email" style="margin-top:4px;color:#6b7280;font:600 13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">${escapeHtml(displayEmail)}</div>` : ''}
        </td>
      </tr>
    </table>
  `;
}

function renderAuthEmail({ title, eyebrow, summary, identity = {}, details = [] }) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="color-scheme" content="light dark">
    <meta name="supported-color-schemes" content="light dark">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      @media (prefers-color-scheme: dark) {
        .body { background:#111113 !important; }
        .card { background:#1c1c1e !important; border-color:rgba(255,255,255,.14) !important; }
        .title { color:#f5f5f7 !important; }
        .copy { color:rgba(245,245,247,.78) !important; }
        .detail-label { color:rgba(245,245,247,.58) !important; }
        .detail-value { color:#ffffff !important; }
        .identity-email { color:rgba(245,245,247,.62) !important; }
        .footer { color:rgba(245,245,247,.52) !important; }
      }
    </style>
  </head>
  <body class="body" style="margin:0;background:#f5f5f7;padding:28px 12px;">
    <div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(summary)}</div>
    <main class="card" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid rgba(0,0,0,.08);border-radius:24px;overflow:hidden;box-shadow:none;">
      <section style="padding:30px 28px 22px;text-align:center;">
        <img src="${LOGO_URL}" width="88" height="88" alt="iClora" style="display:block;margin:0 auto 14px;border:0;object-fit:contain;background:transparent;">
        <p style="margin:0 0 8px;color:#0071e3;font:700 13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;letter-spacing:.02em;">${escapeHtml(eyebrow)}</p>
        <h1 class="title" style="margin:0;color:#111827;font:800 30px/1.12 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">${escapeHtml(title)}</h1>
        <p class="copy" style="margin:12px auto 0;max-width:440px;color:#4b5563;font:500 15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">${escapeHtml(summary)}</p>
        ${renderIdentityBlock(identity)}
      </section>
      <section style="padding:0 28px 28px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
          ${renderDetailRows(details)}
        </table>
        <table role="presentation" cellspacing="0" cellpadding="0" style="margin:24px auto 0;border-collapse:collapse;">
          <tr>
            <td style="border-radius:999px;background:#FFD700;">
              <a href="${MANAGE_ACCOUNT_URL}" style="display:inline-block;padding:12px 22px;border-radius:999px;background:#FFD700;color:#000000;text-decoration:none;font:800 14px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">Check devices</a>
            </td>
          </tr>
        </table>
      </section>
      <p class="footer" style="margin:0;padding:18px 28px 26px;color:#777;font:500 12px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-align:center;">This security alert was sent by iClora. If this was not you, review your active sessions and passkeys.</p>
    </main>
  </body>
</html>`;
}

async function sendResendEmail({ to, subject, html, text }) {
  const apiKey = getResendApiKey();
  const from = getFromAddress();
  if (!apiKey || !from || !to) return { skipped: true };

  const payload = {
    from,
    to: [to],
    subject,
    html,
    text,
  };
  const replyTo = getReplyTo();
  if (replyTo) payload.reply_to = replyTo;

  const response = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json?.message || json?.error || `Resend failed with ${response.status}`);
  }
  return json;
}

export function sendAuthAlert(options = {}) {
  if (!isMailEnabled()) return;

  const to = cleanText(options.email);
  if (!to) return;

  const provider = displayProvider(options.provider);
  const rateKey = `auth:${provider.toLowerCase()}:${to.toLowerCase()}`;
  if (!allowAlertSend(rateKey, { limit: 6, windowMs: 10 * 60 * 1000 })) return;

  const loginAt = formatDateTime(options.loginAt || options.session?.loginAtIso || new Date());
  const user = options.user || {};
  const identity = {
    name: cleanText(options.name) || getDisplayName(user),
    email: to,
    profilePhotoUrl: cleanText(options.profilePhotoUrl) || getProfilePhotoUrl(user),
  };
  const details = [
    { label: 'Name', value: identity.name },
    { label: 'Gmail', value: to },
    { label: 'Sign-in method', value: provider },
    { label: 'Time', value: loginAt },
    { label: 'Device', value: options.session?.deviceName || options.deviceName || '' },
    { label: 'Location', value: getLocationLabel(options.session) },
  ];
  const title = provider === 'Passkey' ? 'Passkey login alert' : `${provider} login alert`;
  const summary = `Your iClora account was signed in with ${provider}${loginAt ? ` on ${loginAt}` : ''}.`;
  const html = renderAuthEmail({
    title,
    eyebrow: '',
    summary,
    identity,
    details,
  });
  const text = `${title}\n\n${summary}\n\n${renderTextDetails(details)}\n\nIf this was not you, review your active sessions and passkeys.`;

  sendResendEmail({
    to,
    subject: `iClora ${title}`,
    html,
    text,
  }).catch((error) => {
    console.warn('iClora auth alert email failed:', error?.message || error);
  });
}

export function sendLoginAlert(options = {}) {
  sendAuthAlert(options);
}

export function sendPasskeyLoginAlert(options = {}) {
  sendAuthAlert({ ...options, provider: 'passkey' });
}
