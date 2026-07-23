import { getFirebaseAdmin } from '../firebase.js';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const LOGO_URL = 'https://iclora.app/pwa-icon-512.png';
const MANAGE_ACCOUNT_URL = 'https://iclora.app/cloud/manage-account';
const alertRateBuckets = new Map();

function allowAlertSend(key, { limit = 8, windowMs = 10 * 60 * 1000 } = {}) {
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

function formatDateOnly(value) {
  const date = toDate(value);
  if (!date) return cleanText(value);
  try {
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'Asia/Kolkata',
    }).format(date);
  } catch {
    return cleanText(value);
  }
}

function formatProvider(provider = '') {
  const value = cleanText(provider);
  if (value === 'google.com' || value === 'firebase') return 'Google';
  if (value === 'passkey') return 'Passkey';
  if (!value) return '';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function countryNameFromCode(code = '') {
  const countryCode = cleanText(code).toUpperCase();
  if (!countryCode) return '';
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(countryCode) || countryCode;
  } catch {
    return countryCode;
  }
}

function ageFromBirthDate(birthDate = '') {
  const parts = cleanText(birthDate).match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (!parts) return '';
  const monthIndex = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
  ].indexOf(parts[2].toLowerCase());
  if (monthIndex < 0) return '';

  const birth = new Date(Date.UTC(Number(parts[3]), monthIndex, Number(parts[1])));
  const now = new Date();
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const hasHadBirthday = now.getUTCMonth() > birth.getUTCMonth()
    || (now.getUTCMonth() === birth.getUTCMonth() && now.getUTCDate() >= birth.getUTCDate());
  if (!hasHadBirthday) age -= 1;
  return Number.isFinite(age) && age >= 0 ? `${age} years old` : '';
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

async function getAccountSnapshot({ config, uid, email = '', user = null, passkeys = null }) {
  if (!uid || !config?.firebaseServiceAccountPath) return null;

  const fbAdmin = getFirebaseAdmin(config.firebaseServiceAccountPath);
  const db = fbAdmin.firestore();
  let nextUser = user;
  let nextPasskeys = passkeys;

  if (!nextUser) {
    const userSnapshot = await db.collection('users').doc(uid).get();
    nextUser = userSnapshot.exists ? userSnapshot.data() || {} : {};
  }

  if (!Array.isArray(nextPasskeys)) {
    const passkeySnapshot = await db.collection('passkey').doc(uid).get();
    const passkeyData = passkeySnapshot.exists ? passkeySnapshot.data() || {} : {};
    nextPasskeys = Array.isArray(passkeyData.passkeys) ? passkeyData.passkeys : [];
  }

  const profilePhotoUpdatedAt = nextUser?.profilePhoto?.updatedAt || '';
  const birthDate = cleanText(nextUser?.birthDate);
  const ageLabel = ageFromBirthDate(birthDate);

  return [
    { label: 'Profile photo', value: profilePhotoUpdatedAt ? `Last updated on ${formatDateTime(profilePhotoUpdatedAt)}` : '' },
    { label: 'Name', value: cleanText(nextUser?.name) },
    { label: 'Date of birth', value: birthDate ? `${birthDate}${ageLabel ? `\n${ageLabel}` : ''}` : '' },
    { label: 'Country/region', value: countryNameFromCode(nextUser?.countryCode) },
    { label: 'Email', value: cleanText(nextUser?.email || email) },
    { label: 'Last login by', value: [formatProvider(nextUser?.lastLoginBy), formatDateTime(nextUser?.lastLoginAt)].filter(Boolean).join('\n') },
    { label: 'Account created on', value: formatDateTime(nextUser?.createdAt) },
    { label: 'Total passkeys', value: `${nextPasskeys.length} passkey${nextPasskeys.length === 1 ? '' : 's'} saved` },
  ].filter((item) => item.value);
}

function renderChangedRows(changes = []) {
  return changes
    .map((change) => `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid rgba(120,120,128,.16);color:#6b7280;font:700 13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">${escapeHtml(change.label)}</td>
        <td style="padding:10px 0;border-bottom:1px solid rgba(120,120,128,.16);color:#111827;font:700 14px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-align:right;white-space:pre-line;">${change.label === 'Name' ? renderGradientName(change.value, '14px') : escapeHtml(change.value)}</td>
      </tr>
    `)
    .join('');
}

function renderSnapshotCards(snapshot = []) {
  return snapshot
    .map((item) => `
      <tr>
        <td style="padding:12px 0;border-bottom:1px solid rgba(120,120,128,.16);color:#6b7280;font:700 13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">${escapeHtml(item.label)}</td>
        <td style="padding:12px 0;border-bottom:1px solid rgba(120,120,128,.16);color:#111827;font:700 14px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-align:right;white-space:pre-line;">${item.label === 'Name' ? renderGradientName(item.value, '14px') : escapeHtml(item.value)}</td>
      </tr>
    `)
    .join('');
}

function renderTextRows(rows = []) {
  return rows.map((row) => `${row.label}: ${row.value}`).join('\n');
}

function getProfilePhotoUrl(user = {}) {
  return cleanText(
    user?.profilePhoto?.url
      || user?.profilePhotoUrl
      || user?.picture
      || user?.photoURL
      || user?.avatar
  );
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

function renderGradientName(value = '', fontSize = '16px') {
  return `<span style="display:inline-block;color:#60a5fa;background:linear-gradient(90deg,#7dd3fc 0%,#60a5fa 34%,#6366f1 68%,#a855f7 100%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;font:800 ${fontSize} -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">${escapeHtml(value)}</span>`;
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

function renderSettingsEmail({ title, summary, identity, changes, snapshot }) {
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
        .title,.section-title { color:#f5f5f7 !important; }
        .copy { color:rgba(245,245,247,.76) !important; }
        td { color:#f5f5f7 !important; }
        .identity-email { color:rgba(245,245,247,.62) !important; }
        .footer { color:rgba(245,245,247,.52) !important; }
      }
    </style>
  </head>
  <body class="body" style="margin:0;background:#f5f5f7;padding:28px 12px;">
    <div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(summary)}</div>
    <main class="card" style="max-width:620px;margin:0 auto;background:#ffffff;border:1px solid rgba(0,0,0,.08);border-radius:24px;overflow:hidden;box-shadow:none;">
      <section style="padding:30px 28px 18px;text-align:center;">
        <img src="${LOGO_URL}" width="84" height="84" alt="iClora" style="display:block;margin:0 auto 14px;border:0;object-fit:contain;background:transparent;">
        <h1 class="title" style="margin:0;color:#111827;font:800 30px/1.12 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">${escapeHtml(title)}</h1>
        <p class="copy" style="margin:12px auto 0;max-width:480px;color:#4b5563;font:500 15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">${escapeHtml(summary)}</p>
        ${renderIdentityBlock(identity)}
      </section>
      <section style="padding:4px 28px 22px;">
        <h2 class="section-title" style="margin:0 0 8px;color:#111827;font:800 17px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">Changed</h2>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">${renderChangedRows(changes)}</table>
      </section>
      <section style="padding:0 28px 28px;">
        <h2 class="section-title" style="margin:0 0 8px;color:#111827;font:800 17px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">Account summary</h2>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">${renderSnapshotCards(snapshot)}</table>
        <table role="presentation" cellspacing="0" cellpadding="0" style="margin:24px auto 0;border-collapse:collapse;">
          <tr>
            <td style="border-radius:999px;background:#FFD700;">
              <a href="${MANAGE_ACCOUNT_URL}" style="display:inline-block;padding:12px 22px;border-radius:999px;background:#FFD700;color:#000000;text-decoration:none;font:800 14px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">Visit setting page</a>
            </td>
          </tr>
        </table>
      </section>
      <p class="footer" style="margin:0;padding:18px 28px 26px;color:#777;font:500 12px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-align:center;">You are receiving this because your iClora account settings changed.</p>
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

export function sendSettingsAlert(options = {}) {
  if (!isMailEnabled()) return;

  const uid = cleanText(options.uid);
  const initialEmail = cleanText(options.email || options.user?.email);
  if (!uid) return;

  const changes = Array.isArray(options.changes)
    ? options.changes.filter((change) => change?.label && change?.value)
    : [];
  if (!changes.length) return;

  (async () => {
    let resolvedUser = options.user || null;
    let email = initialEmail;
    if ((!resolvedUser || !email) && options.config?.firebaseServiceAccountPath) {
      const fbAdmin = getFirebaseAdmin(options.config.firebaseServiceAccountPath);
      const userSnapshot = await fbAdmin.firestore().collection('users').doc(uid).get();
      resolvedUser = userSnapshot.exists ? userSnapshot.data() || {} : resolvedUser;
      email = email || cleanText(resolvedUser?.email);
    }
    if (!email) return;
    const title = cleanText(options.title, 'iClora account updated');
    const rateKey = `settings:${title.toLowerCase()}:${email.toLowerCase()}`;
    if (!allowAlertSend(rateKey, { limit: 8, windowMs: 10 * 60 * 1000 })) return;

    const snapshot = await getAccountSnapshot({
      config: options.config,
      uid,
      email,
      user: resolvedUser,
      passkeys: options.passkeys || null,
    });
    const summary = cleanText(options.summary, 'A setting on your iClora account was changed.');
    const identity = {
      name: getDisplayName(resolvedUser || {}) || 'iClora user',
      email,
      profilePhotoUrl: getProfilePhotoUrl(resolvedUser || {}),
    };
    const identityRows = [
      { label: 'Name', value: identity.name },
      { label: 'Gmail', value: email },
    ].filter((row) => row.value);
    const displayChanges = [...identityRows, ...changes];
    const html = renderSettingsEmail({
      title,
      summary,
      identity,
      changes: displayChanges,
      snapshot,
    });
    const text = `${title}\n\n${summary}\n\nChanged\n${renderTextRows(displayChanges)}\n\nAccount summary\n${renderTextRows(snapshot || [])}`;

    await sendResendEmail({
      to: email,
      subject: `iClora ${title}`,
      html,
      text,
    });
  })().catch((error) => {
    console.warn('iClora settings alert email failed:', error?.message || error);
  });
}

export function formatSettingsDateTime(value) {
  return formatDateTime(value);
}

export function formatSettingsDateOnly(value) {
  return formatDateOnly(value);
}
