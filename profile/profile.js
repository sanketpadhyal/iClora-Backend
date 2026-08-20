import express from 'express';
import jwt from 'jsonwebtoken';
import { getFirebaseAdmin } from '../firebase.js';
import { sendSettingsAlert } from '../alerts-mails/settingsmail.js';

const monthNames = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const countryCodes = new Set([
  'AF', 'AX', 'AL', 'DZ', 'AS', 'AD', 'AO', 'AI', 'AQ', 'AG', 'AR', 'AM', 'AW', 'AU', 'AT', 'AZ',
  'BS', 'BH', 'BD', 'BB', 'BY', 'BE', 'BZ', 'BJ', 'BM', 'BT', 'BO', 'BQ', 'BA', 'BW', 'BV', 'BR',
  'IO', 'BN', 'BG', 'BF', 'BI', 'CV', 'KH', 'CM', 'CA', 'KY', 'CF', 'TD', 'CL', 'CN', 'CX', 'CC',
  'CO', 'KM', 'CG', 'CD', 'CK', 'CR', 'CI', 'HR', 'CU', 'CW', 'CY', 'CZ', 'DK', 'DJ', 'DM', 'DO',
  'EC', 'EG', 'SV', 'GQ', 'ER', 'EE', 'SZ', 'ET', 'FK', 'FO', 'FJ', 'FI', 'FR', 'GF', 'PF', 'TF',
  'GA', 'GM', 'GE', 'DE', 'GH', 'GI', 'GR', 'GL', 'GD', 'GP', 'GU', 'GT', 'GG', 'GN', 'GW', 'GY',
  'HT', 'HM', 'VA', 'HN', 'HK', 'HU', 'IS', 'IN', 'ID', 'IR', 'IQ', 'IE', 'IM', 'IL', 'IT', 'JM',
  'JP', 'JE', 'JO', 'KZ', 'KE', 'KI', 'KM', 'KP', 'KR', 'KW', 'KG', 'LA', 'LV', 'LB', 'LS', 'LR',
  'LY', 'LI', 'LT', 'LU', 'MO', 'MG', 'MW', 'MY', 'MV', 'ML', 'MT', 'MH', 'MQ', 'MR', 'MU', 'YT',
  'MX', 'FM', 'MD', 'MC', 'MN', 'ME', 'MS', 'MA', 'MZ', 'MM', 'NA', 'NR', 'NP', 'NL', 'NC', 'NZ',
  'NI', 'NE', 'NG', 'NU', 'NF', 'MK', 'MP', 'NO', 'OM', 'PK', 'PW', 'PS', 'PA', 'PG', 'PY', 'PE',
  'PH', 'PN', 'PL', 'PT', 'PR', 'QA', 'RE', 'RO', 'RU', 'RW', 'BL', 'SH', 'KN', 'LC', 'MF', 'PM',
  'VC', 'WS', 'SM', 'ST', 'SA', 'SN', 'RS', 'SC', 'SL', 'SG', 'SX', 'SK', 'SI', 'SB', 'SO', 'ZA',
  'GS', 'SS', 'ES', 'LK', 'SD', 'SR', 'SJ', 'SE', 'CH', 'SY', 'TW', 'TJ', 'TZ', 'TH', 'TL', 'TG',
  'TK', 'TO', 'TT', 'TN', 'TR', 'TM', 'TC', 'TV', 'UG', 'UA', 'AE', 'GB', 'US', 'UM', 'UY', 'UZ',
  'VU', 'VE', 'VN', 'VG', 'VI', 'WF', 'EH', 'YE', 'ZM', 'ZW',
]);

function readBearerToken(req) {
  const authHeader = req.get('authorization') || '';
  if (authHeader.toLowerCase().startsWith('bearer ')) return authHeader.slice(7).trim();
  return '';
}

function requireProfileSession(config) {
  return (req, res, next) => {
    try {
      const bearer = readBearerToken(req);
      const token = bearer || req.cookies?.[config.cookieName];
      if (!token) return res.status(401).json({ ok: false, error: 'Missing session' });
      if (!config.jwtSecret) return res.status(500).json({ ok: false, error: 'JWT_SECRET is missing' });

      let decoded;
      try {
        decoded = jwt.verify(token, config.jwtSecret, {
          issuer: config.jwtIssuer,
          audience: config.jwtAudience,
        });
      } catch {
        decoded = jwt.verify(token, config.jwtSecret);
      }

      if (!decoded?.uid) return res.status(401).json({ ok: false, error: 'Invalid session' });
      req.session = { uid: decoded.uid, email: decoded.email || '' };
      return next();
    } catch {
      return res.status(401).json({ ok: false, error: 'Invalid session' });
    }
  };
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeName(value) {
  if (!value || typeof value !== 'object') return null;
  const firstName = cleanText(value.firstName, 50);
  const middleName = cleanText(value.middleName, 50);
  const lastName = cleanText(value.lastName, 50);
  const name = [firstName, middleName, lastName].filter(Boolean).join(' ');

  if (!firstName && !lastName) throw new Error('First name or last name is required');
  if (name.length > 140) throw new Error('Name is too long');

  return { firstName, middleName, lastName, name };
}

function normalizeBirthDate(value) {
  if (!value || typeof value !== 'object') return null;
  const day = Number(value.day);
  const month = cleanText(value.month, 20);
  const year = Number(value.year);
  const monthIndex = monthNames.indexOf(month);
  const currentYear = new Date().getFullYear();

  if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error('Invalid birth day');
  if (monthIndex < 0) throw new Error('Invalid birth month');
  if (!Number.isInteger(year) || year < 1900 || year > currentYear) throw new Error('Invalid birth year');

  const candidate = new Date(Date.UTC(year, monthIndex, day));
  if (
    candidate.getUTCFullYear() !== year
    || candidate.getUTCMonth() !== monthIndex
    || candidate.getUTCDate() !== day
  ) {
    throw new Error('Invalid birth date');
  }

  return {
    birthDate: `${day} ${month} ${year}`,
    birthDateParts: { day: String(day), month, year: String(year) },
  };
}

function normalizeCountry(value) {
  if (typeof value !== 'string') return null;
  const countryCode = value.trim().toUpperCase();
  if (!countryCodes.has(countryCode)) throw new Error('Invalid country or region');
  return { countryCode };
}

function countryNameFromCode(code) {
  if (!code) return '';
  try {
    if (Intl?.DisplayNames) {
      const names = new Intl.DisplayNames(['en'], { type: 'region' });
      return names.of(code) || '';
    }
  } catch {
    return '';
  }
  return '';
}

function profileResponse({ uid, email, user }) {
  const countryCode = typeof user?.countryCode === 'string' ? user.countryCode : '';
  return {
    ok: true,
    uid,
    email,
    name: typeof user?.name === 'string' ? user.name : '',
    firstName: typeof user?.firstName === 'string' ? user.firstName : '',
    middleName: typeof user?.middleName === 'string' ? user.middleName : '',
    lastName: typeof user?.lastName === 'string' ? user.lastName : '',
    birthDate: typeof user?.birthDate === 'string' ? user.birthDate : '',
    dob: typeof user?.birthDate === 'string' ? user.birthDate : '',
    countryCode,
    countryName: countryNameFromCode(countryCode),
  };
}

export default function createProfileRouter({ config }) {
  const router = express.Router();
  router.use(requireProfileSession(config));

  router.put('/me', async (req, res) => {
    try {
      const { uid, email } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });

      const namePayload = normalizeName(req.body?.name);
      const birthDatePayload = normalizeBirthDate(req.body?.birthDate);
      const countryPayload = normalizeCountry(req.body?.countryCode);

      if (!namePayload && !birthDatePayload && !countryPayload) {
        return res.status(400).json({ ok: false, error: 'Nothing to update' });
      }

      const fbAdmin = getFirebaseAdmin(config.firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const userRef = db.collection('users').doc(uid);
      const currentSnapshot = await userRef.get();
      const currentUser = currentSnapshot.exists ? currentSnapshot.data() || {} : {};
      const update = {
        profileUpdatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
      };

      if (namePayload) Object.assign(update, namePayload);
      if (birthDatePayload) Object.assign(update, birthDatePayload);
      if (countryPayload) Object.assign(update, countryPayload);

      await userRef.set(update, { merge: true });
      const nextSnapshot = await userRef.get();
      const nextUser = nextSnapshot.exists ? nextSnapshot.data() || {} : {};
      const changes = [];

      if (namePayload && currentUser.name !== nextUser.name) {
        changes.push({ label: 'Name', value: nextUser.name || namePayload.name });
      }
      if (birthDatePayload && currentUser.birthDate !== nextUser.birthDate) {
        changes.push({ label: 'Date of birth', value: nextUser.birthDate || birthDatePayload.birthDate });
      }
      if (countryPayload && currentUser.countryCode !== nextUser.countryCode) {
        changes.push({ label: 'Country/region', value: countryNameFromCode(nextUser.countryCode || countryPayload.countryCode) });
      }

      sendSettingsAlert({
        config,
        uid,
        email: email || nextUser.email || currentUser.email || '',
        user: nextUser,
        title: 'Profile settings updated',
        summary: 'Your iClora profile details were changed.',
        changes,
      });

      return res.json(profileResponse({ uid, email, user: nextUser }));
    } catch (error) {
      return res.status(400).json({ ok: false, error: error?.message || 'Failed to update profile' });
    }
  });

  return router;
}
