import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import Redis from 'ioredis';
import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { createHash, randomUUID } from 'crypto';
import { handleFirebaseIdToken } from './auth/auth.js';
import createPasskeyRouter from './auth/passkey.js';
import createDeleteAccountRouter from './auth/deleteaccount.js';
import createAuthActivityRouter, {
  ensureSessionIsActive,
  expireSessionActivity,
  getSessionIdFromDecoded,
  hasExpiredSessionActivity,
  recordLoginActivity,
} from './auth/authactivity.js';
import { getFirebaseAdmin } from './firebase.js';
import createDashboardTweaksRouter from './dashboard_tweeks/tweeks.js';
import createProfileRouter from './profile/profile.js';
import createNotesRouter from './notes/notes.js';
import createNotesSetupRouter from './notes/setupnotes.js';
import createSupabaseNotesRouter from './notes/notes.supabase.js';
import createSupabaseNotesSetupRouter from './notes/setupnotes.supabase.js';
import createPhotosSetupRouter from './photos/setupphotos.js';
import createPhotosRouter from './photos/photos.js';
import createRecentlyDeletedRouter from './photos/recentlydeleted.js';
import createContactsSetupRouter from './contacts/setupcontact.js';
import createContactsRouter from './contacts/contacts.js';
import createSupabaseContactsSetupRouter from './contacts/setupcontact.supabase.js';
import createSupabaseContactsRouter from './contacts/contacts.supabase.js';
import createContactsPhotoRouter from './contacts/photo.js';
import createCloudAppsNormalizeRouter from './cloud_apps/normalize.js';
import { startVisionCycle } from './vision process/visioncycle.js';
import { getSupabaseAdmin, hasSupabaseConfig } from './supabase/client.js';
import { assertStorageCapacity, toMbFromBytes } from './storage/quota.js';
import { sendLoginAlert } from './alerts-mails/authmail.js';
import { formatSettingsDateTime, sendSettingsAlert } from './alerts-mails/settingsmail.js';

dotenv.config();

function getPort() {
  const port = Number(process.env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT value: ${process.env.PORT}`);
  }
  return port;
}

const config = {
  port: getPort(),
  host: process.env.HOST || '0.0.0.0',
  frontendOrigin: process.env.FRONTEND_ORIGIN || process.env.FRONTEND_URL || 'http://localhost:3000',
  redisEnabled: process.env.REDIS_ENABLED === 'true',
  redisUrl: process.env.REDIS_URL || '',
  jwtSecret: process.env.JWT_SECRET || '',
  jwtIssuer: process.env.JWT_ISSUER || 'lumia',
  jwtAudience: process.env.JWT_AUDIENCE || 'lumia-web',
  firebaseServiceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './service-account.json',
  cookieName: process.env.COOKIE_NAME || 'lumia_session',
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  cookieSameSite: process.env.COOKIE_SAME_SITE || 'lax',
  cloudinaryCloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
  cloudinaryApiKey: process.env.CLOUDINARY_API_KEY || '',
  cloudinaryApiSecret: process.env.CLOUDINARY_API_SECRET || '',
  visionApiUrl: process.env.VISION_API_URL || process.env.REACT_APP_VISION_API_URL || '',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
};
const useSupabaseForNotes = hasSupabaseConfig();
const useSupabaseForContacts = hasSupabaseConfig();

const allowedOrigins = config.frontendOrigin
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const localDevOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5173',
  'http://localhost:8081',
  'http://localhost:8082',
  'http://localhost:8083',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:8081',
  'http://127.0.0.1:8082',
  'http://127.0.0.1:8083',
];
if (process.env.NODE_ENV !== 'production') {
  for (const origin of localDevOrigins) {
    if (!allowedOrigins.includes(origin)) allowedOrigins.push(origin);
  }
}
const SESSION_MAX_AGE_MS = 5 * 60 * 60 * 1000;
const APPLICATION_SESSION_MAX_AGE_MS = 10 * 24 * 60 * 60 * 1000;

if (process.env.NODE_ENV === 'production' && config.jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters in production');
}

function isAllowedOrigin(origin = '') {
  return !origin || allowedOrigins.includes(origin);
}

function getCookiePolicyForOrigin(origin = '') {
  const isLocalhost = /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  if (isLocalhost) {
    return {
      sameSite: 'lax',
      secure: false,
    };
  }
  return {
    sameSite: config.cookieSameSite,
    secure: config.cookieSecure,
  };
}

function signSessionJwt({ uid, email, sessionId = randomUUID(), expiresIn = '5h', clientType = 'web' }) {
  if (!config.jwtSecret) throw new Error('JWT_SECRET is missing');
  return jwt.sign(
    { uid, email, sid: sessionId, clientType },
    config.jwtSecret,
    {
      algorithm: 'HS256',
      expiresIn,
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
      jwtid: sessionId,
    }
  );
}

const redis = config.redisEnabled && config.redisUrl
  ? new Redis(config.redisUrl, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    lazyConnect: true,
  })
  : null;

if (redis) {
  redis.on('error', (error) => {
    // eslint-disable-next-line no-console
    console.warn('Redis unavailable, falling back to memory rate limiter:', error.message);
  });
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(cookieParser());
app.use(express.json({ limit: '256kb' }));
app.use(
  cors({
    origin(origin, callback) {
      if (isAllowedOrigin(origin)) return callback(null, true);
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  })
);
app.use((req, res, next) => {
  const unsafeMethod = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  const origin = req.headers.origin || '';
  const usesCookieSession = Boolean(req.cookies?.[config.cookieName]);
  const clientHeader = String(req.get('x-iclora-client') || '').trim().toLowerCase();
  const applicationClient = clientHeader === 'application' || clientHeader === 'mobile';
  if (unsafeMethod && applicationClient && !usesCookieSession) {
    return next();
  }
  if (unsafeMethod && origin && !allowedOrigins.includes(origin)) {
    return res.status(403).json({ ok: false, error: 'Invalid request origin' });
  }
  if (unsafeMethod && usesCookieSession && !origin) {
    return res.status(403).json({ ok: false, error: 'Missing request origin' });
  }
  return next();
});

function createLimiter({ windowMs, limit, prefix, message, extraOptions = {} }) {
  const baseOptions = {
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: message || 'Too many requests. Please try again shortly.' },
    ...extraOptions,
  };

  if (!redis) return rateLimit(baseOptions);
  try {
    return rateLimit({
      ...baseOptions,
      store: new RedisStore({
        sendCommand: (...args) => redis.call(...args),
        prefix,
      }),
    });
  } catch {
    return rateLimit(baseOptions);
  }
}

const authLimiter = createLimiter({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  prefix: 'rl:auth:',
  message: 'Too many sign-in attempts. Please try again shortly.',
});

const sensitiveActionLimiter = createLimiter({
  windowMs: 10 * 60 * 1000,
  limit: 12,
  prefix: 'rl:sensitive:',
  message: 'Too many sensitive account attempts. Please wait and try again.',
});

const storageRefreshLimiter = createLimiter({
  windowMs: 60 * 1000,
  limit: 3,
  prefix: 'rl:storage-refresh:',
  message: 'Storage refresh limit reached. Try again in a minute.',
  extraOptions: {
    keyGenerator: (req) => {
      const uid = typeof req?.session?.uid === 'string' ? req.session.uid.trim() : '';
      if (uid) return `uid:${uid}`;
      const sessionId = typeof req?.session?.sessionId === 'string' ? req.session.sessionId.trim() : '';
      if (sessionId) return `sid:${sessionId}`;
      return req.ip || 'unknown';
    },
  },
});

app.get('/health', async (_req, res) => {
  if (!redis) {
    return res.json({ ok: true, redis: 'disabled' });
  }

  try {
    await redis.connect();
    await redis.ping();
    res.json({ ok: true });
  } catch {
    res.status(200).json({ ok: true, redis: 'unavailable' });
  }
});

function clearSessionCookie(req, res) {
  const cookiePolicy = getCookiePolicyForOrigin(req.headers.origin || '');
  res.clearCookie(config.cookieName, {
    path: '/',
    sameSite: cookiePolicy.sameSite,
    secure: cookiePolicy.secure,
  });
}

function getLegacySessionId(token = '') {
  return `legacy-${createHash('sha256').update(token).digest('hex').slice(0, 32)}`;
}

function isApplicationClient(req) {
  const headerClient = String(req.get('x-iclora-client') || '').trim().toLowerCase();
  const bodyClient = String(req.body?.clientType || req.body?.client || '').trim().toLowerCase();
  return headerClient === 'application' || bodyClient === 'application' || bodyClient === 'mobile';
}

app.post('/auth/session', authLimiter, async (req, res) => {
  try {
    const { idToken, loginOnly } = req.body || {};
    const applicationClient = isApplicationClient(req);
    const sessionMaxAgeMs = applicationClient ? APPLICATION_SESSION_MAX_AGE_MS : SESSION_MAX_AGE_MS;
    const result = await handleFirebaseIdToken({
      idToken: typeof idToken === 'string' ? idToken : '',
      config,
      signJwt: (payload) => signSessionJwt({
        ...payload,
        expiresIn: applicationClient ? '10d' : '5h',
        clientType: applicationClient ? 'application' : 'web',
      }),
      loginOnly: Boolean(loginOnly),
    });

    const cookiePolicy = getCookiePolicyForOrigin(req.headers.origin || '');
    const sessionExpiresAt = Date.now() + sessionMaxAgeMs;
    const decodedSession = jwt.decode(result.sessionJwt) || {};
    const sessionId = getSessionIdFromDecoded(decodedSession);

    const loginSession = await recordLoginActivity({
      config,
      uid: result.uid,
      email: result.email,
      sessionId,
      provider: result.provider || 'firebase',
      req,
      expiresAtMs: sessionExpiresAt,
    });
    sendLoginAlert({
      email: result.email,
      name: result.name || '',
      profilePhotoUrl: result.profilePhotoUrl || '',
      provider: result.provider || 'firebase',
      loginAt: new Date(),
      session: loginSession,
    });

    if (!applicationClient) {
      res.cookie(config.cookieName, result.sessionJwt, {
        httpOnly: true,
        sameSite: cookiePolicy.sameSite,
        secure: cookiePolicy.secure,
        maxAge: SESSION_MAX_AGE_MS,
        path: '/',
      });
    }

    res.json({
      ok: true,
      clientType: applicationClient ? 'application' : 'web',
      uid: result.uid,
      email: result.email,
      name: result.name || '',
      provider: result.provider || '',
      sessionToken: result.sessionJwt,
      sessionExpiresAt,
      sessionId,
      plan: result.plan || 'basic',
      storage: typeof result.storage === 'number' ? result.storage : 1024,
      storageused: typeof result.storageused === 'number' ? result.storageused : 0,
      isNewUser: Boolean(result.isNewUser),
      profilePhotoUrl: result.profilePhotoUrl || '',
      needsProfilePhoto: Boolean(result.needsProfilePhoto),
    });
  } catch (error) {
    res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Authentication failed' });
  }
});

async function requireSession(req, res, next) {
  try {
    const authHeader = req.get('authorization') || '';
    const bearerToken = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
    const token = bearerToken || req.cookies?.[config.cookieName];
    if (!token) return res.status(401).json({ ok: false, error: 'Missing session' });
    if (!config.jwtSecret) return res.status(500).json({ ok: false, error: 'JWT_SECRET is missing' });

    let decoded;
    try {
      decoded = jwt.verify(token, config.jwtSecret, {
        issuer: config.jwtIssuer,
        audience: config.jwtAudience,
      });
    } catch (error) {
      if (error?.name === 'TokenExpiredError') {
        const expiredDecoded = jwt.decode(token) || {};
        const expiredSessionId = getSessionIdFromDecoded(expiredDecoded);
        if (expiredDecoded?.uid && expiredSessionId) {
          await expireSessionActivity({
            config,
            uid: expiredDecoded.uid,
            sessionId: expiredSessionId,
            reason: 'session_expired',
            req,
          });
        }
        clearSessionCookie(req, res);
        return res.status(401).json({ ok: false, error: 'Session expired' });
      }

      try {
        decoded = jwt.verify(token, config.jwtSecret);
      } catch (innerError) {
        if (innerError?.name === 'TokenExpiredError') {
          clearSessionCookie(req, res);
          return res.status(401).json({ ok: false, error: 'Session expired' });
        }
        const fbAdmin = getFirebaseAdmin(config.firebaseServiceAccountPath);
        const firebaseDecoded = await fbAdmin.auth().verifyIdToken(token);
        decoded = {
          uid: firebaseDecoded.uid,
          email: firebaseDecoded.email || '',
        };
      }
    }

    if (!decoded?.uid) return res.status(401).json({ ok: false, error: 'Invalid session' });
    let sessionId = getSessionIdFromDecoded(decoded);
    if (!sessionId) {
      sessionId = getLegacySessionId(token);
    }

    const wasLoggedOut = await hasExpiredSessionActivity({
      config,
      uid: decoded.uid,
      sessionId,
    });
    if (wasLoggedOut) {
      clearSessionCookie(req, res);
      return res.status(401).json({ ok: false, error: 'Session expired' });
    }

    const active = await ensureSessionIsActive({
      config,
      uid: decoded.uid,
      sessionId,
    });
    if (!active) {
      await recordLoginActivity({
        config,
        uid: decoded.uid,
        email: decoded.email || '',
        sessionId,
        provider: 'recovered',
        req,
        expiresAtMs: decoded.exp ? decoded.exp * 1000 : Date.now() + SESSION_MAX_AGE_MS,
      }).catch(() => {});
    }

    req.session = { uid: decoded.uid, email: decoded.email || '', sessionId };
    return next();
  } catch (err) {
    return res.status(401).json({ ok: false, error: 'Invalid session' });
  }
}

app.use(
  '/dashboard-tweaks',
  requireSession,
  createDashboardTweaksRouter({ firebaseServiceAccountPath: config.firebaseServiceAccountPath })
);

app.use('/profile', createProfileRouter({ config }));

app.use(createPasskeyRouter({
  config,
  requireSession,
  authLimiter,
  signSessionJwt,
  sessionMaxAgeMs: SESSION_MAX_AGE_MS,
  getCookiePolicyForOrigin,
  recordLoginActivity,
}));

app.use(createAuthActivityRouter({
  config,
  requireSession,
  clearSessionCookie,
}));

app.use(createDeleteAccountRouter({
  config,
  requireSession,
  clearSessionCookie,
  sensitiveActionLimiter,
}));

app.use(createPhotosRouter({
  firebaseServiceAccountPath: config.firebaseServiceAccountPath,
  requireSession,
  config,
  useSupabaseForNotes,
  useSupabaseForContacts,
}));

app.use(createRecentlyDeletedRouter({
  firebaseServiceAccountPath: config.firebaseServiceAccountPath,
  requireSession,
  config,
}));

startVisionCycle({
  firebaseServiceAccountPath: config.firebaseServiceAccountPath,
  config,
  visionApiUrl: config.visionApiUrl,
});

if (useSupabaseForNotes) {
  app.use(createSupabaseNotesSetupRouter({ requireSession }));
  app.use(createSupabaseNotesRouter({
    requireSession,
    firebaseServiceAccountPath: config.firebaseServiceAccountPath,
  }));
} else {
  app.use(createNotesSetupRouter({
    firebaseServiceAccountPath: config.firebaseServiceAccountPath,
    requireSession,
  }));

  app.use(createNotesRouter({
    firebaseServiceAccountPath: config.firebaseServiceAccountPath,
    requireSession,
  }));
}

app.use(createPhotosSetupRouter({
  firebaseServiceAccountPath: config.firebaseServiceAccountPath,
  requireSession,
}));

if (useSupabaseForContacts) {
  app.use(createSupabaseContactsSetupRouter({ requireSession }));
  app.use(createSupabaseContactsRouter({
    requireSession,
    config,
    firebaseServiceAccountPath: config.firebaseServiceAccountPath,
  }));
} else {
  app.use(createContactsSetupRouter({
    firebaseServiceAccountPath: config.firebaseServiceAccountPath,
    requireSession,
  }));

  app.use(createContactsRouter({
    firebaseServiceAccountPath: config.firebaseServiceAccountPath,
    requireSession,
    config,
  }));
}

app.use(createContactsPhotoRouter({
  config,
  requireSession,
  useSupabaseForContacts,
  useSupabaseForNotes,
}));

app.use(createCloudAppsNormalizeRouter({
  firebaseServiceAccountPath: config.firebaseServiceAccountPath,
  requireSession,
}));

function ensureCloudinaryConfigured() {
  if (!config.cloudinaryCloudName || !config.cloudinaryApiKey || !config.cloudinaryApiSecret) {
    throw new Error('Cloudinary is not configured');
  }

  cloudinary.config({
    cloud_name: config.cloudinaryCloudName,
    api_key: config.cloudinaryApiKey,
    api_secret: config.cloudinaryApiSecret,
  });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

const APP_STORAGE_SOURCES = [
  { key: 'photos', label: 'Photos', color: '#ff2f92' },
  { key: 'notes', label: 'Notes', color: '#f5c542' },
  { key: 'contacts', label: 'Contacts', color: '#2f7be6' },
];

function normalizeStorageMb(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.max(0, amount) : 0;
}

function textStorageMb(...parts) {
  const bytes = parts.reduce((total, part) => total + Buffer.byteLength(String(part || ''), 'utf8'), 0);
  return Number((bytes / (1024 * 1024)).toFixed(4));
}

function noteRowStorageMb(row = {}) {
  const stored = Number(row.storage_used);
  if (Number.isFinite(stored) && stored > 0) return stored;
  return textStorageMb(row.title, row.content);
}

function contactRowStorageMb(row = {}) {
  const storedTextStorage = Number(row.storage_used);
  const extraPhones = Array.isArray(row.extra_phones) ? row.extra_phones : [];
  const textStorageUsed = Number.isFinite(storedTextStorage) && storedTextStorage > 0
    ? storedTextStorage
    : textStorageMb(row.display_name, row.first_name, row.last_name, row.company, row.phone, ...extraPhones, row.email, row.birthday, row.address, row.note);
  return Number(textStorageUsed || 0) + Number(row.photo_storage_used || 0);
}

function readProfilePhotoStorageMb(user = {}) {
  const explicitBytes = Number(user?.profilePhoto?.bytes);
  if (Number.isFinite(explicitBytes) && explicitBytes > 0) {
    return Number((explicitBytes / (1024 * 1024)).toFixed(4));
  }
  return 0;
}

function photoStorageMb(data = {}) {
  const stored = Number(data.storageUsed);
  if (Number.isFinite(stored) && stored > 0) return stored;
  return toMbFromBytes(data.bytes);
}

async function readDeletedPhotosStorage(userRef, uid) {
  const [trashSnapshot, legacyDeletedSnapshot] = await Promise.all([
    userRef.firestore.collection('recentlyDeleted').doc(uid).collection('photos').get(),
    userRef.collection('photos').where('deleted', '==', true).get(),
  ]);
  const trashStorage = trashSnapshot.docs.reduce((total, doc) => total + photoStorageMb(doc.data() || {}), 0);
  const legacyStorage = legacyDeletedSnapshot.docs.reduce((total, doc) => total + photoStorageMb(doc.data() || {}), 0);
  return normalizeStorageMb(trashStorage + legacyStorage);
}

async function readSupabaseNotesStorage(uid, { exact = false } = {}) {
  if (!useSupabaseForNotes) return null;
  try {
    const sb = getSupabaseAdmin();
    if (!exact) {
      const metaResult = await sb
        .from('notes_meta')
        .select('active,storage_used')
        .eq('user_id', uid)
        .maybeSingle();
      if (!metaResult.error && metaResult.data) {
        return {
          active: metaResult.data.active === true,
          storageUsed: normalizeStorageMb(metaResult.data.storage_used),
        };
      }
    }

    const [metaResult, storageResult] = await Promise.all([
      sb.from('notes_meta').select('active').eq('user_id', uid).maybeSingle(),
      sb.from('notes_items').select('title,content,storage_used').eq('user_id', uid),
    ]);
    if (metaResult.error || storageResult.error) return { active: false, storageUsed: 0 };
    const storageUsed = normalizeStorageMb((storageResult.data || []).reduce((total, row) => total + noteRowStorageMb(row), 0));
    if (metaResult.data?.active === true) {
      sb.from('notes_meta').update({
        storage_used: storageUsed,
        updated_at: new Date().toISOString(),
      }).eq('user_id', uid).then(() => {}, () => {});
    }
    return {
      active: metaResult.data?.active === true,
      storageUsed,
    };
  } catch {
    return { active: false, storageUsed: 0 };
  }
}

async function readSupabaseContactsStorage(uid, { exact = false } = {}) {
  if (!useSupabaseForContacts) return null;
  try {
    const sb = getSupabaseAdmin();
    if (!exact) {
      const metaResult = await sb
        .from('contacts_meta')
        .select('active,storage_used')
        .eq('user_id', uid)
        .maybeSingle();
      if (!metaResult.error && metaResult.data) {
        return {
          active: metaResult.data.active === true,
          storageUsed: normalizeStorageMb(metaResult.data.storage_used),
        };
      }
    }

    const [metaResult, storageResult] = await Promise.all([
      sb.from('contacts_meta').select('active').eq('user_id', uid).maybeSingle(),
      sb
        .from('contacts_items')
        .select('display_name,first_name,last_name,company,phone,extra_phones,email,birthday,address,note,storage_used,photo_storage_used')
        .eq('user_id', uid),
    ]);
    if (metaResult.error || storageResult.error) return { active: false, storageUsed: 0 };
    const storageUsed = normalizeStorageMb((storageResult.data || []).reduce((total, row) => total + contactRowStorageMb(row), 0));
    if (metaResult.data?.active === true) {
      sb.from('contacts_meta').update({
        storage_used: storageUsed,
        updated_at: new Date().toISOString(),
      }).eq('user_id', uid).then(() => {}, () => {});
    }
    return {
      active: metaResult.data?.active === true,
      storageUsed,
    };
  } catch {
    return { active: false, storageUsed: 0 };
  }
}

async function readAppStorageBreakdown(userRef, uid, user = {}, { exact = false } = {}) {
  try {
    const [snapshots, supabaseNotes, supabaseContacts] = await Promise.all([
      Promise.all(APP_STORAGE_SOURCES.map((app) => userRef.collection(app.key).doc('meta').get().catch(() => ({ exists: false, data: () => ({}) })))),
      readSupabaseNotesStorage(uid, { exact }).catch(() => null),
      readSupabaseContactsStorage(uid, { exact }).catch(() => null),
    ]);
    const photosMeta = snapshots[0]?.exists ? snapshots[0].data() || {} : {};
    const deletedPhotosStorage = !exact && typeof photosMeta.deletedStorageUsed === 'number'
      ? normalizeStorageMb(photosMeta.deletedStorageUsed)
      : await readDeletedPhotosStorage(userRef, uid).catch(() => 0);

    const breakdown = APP_STORAGE_SOURCES.map((app, index) => {
      const data = snapshots[index]?.exists ? snapshots[index].data() || {} : {};
      if (app.key === 'notes' && supabaseNotes) {
        return {
          key: app.key,
          label: app.label,
          color: app.color,
          active: supabaseNotes.active,
          storageUsed: supabaseNotes.storageUsed,
        };
      }
      if (app.key === 'contacts' && supabaseContacts) {
        return {
          key: app.key,
          label: app.label,
          color: app.color,
          active: supabaseContacts.active,
          storageUsed: supabaseContacts.storageUsed,
        };
      }
      return {
        key: app.key,
        label: app.label,
        color: app.color,
        active: data.active === true,
        storageUsed: Number((normalizeStorageMb(data.storageUsed) + (app.key === 'photos' ? deletedPhotosStorage : 0)).toFixed(4)),
      };
    });

    const profilePhotoStorageMb = readProfilePhotoStorageMb(user);
    const nextBreakdown = breakdown.map((app) => (
      app.key === 'photos'
        ? { ...app, storageUsed: Number((app.storageUsed + profilePhotoStorageMb).toFixed(4)) }
        : app
    ));

    return {
      storageused: Number(nextBreakdown.reduce((total, app) => total + app.storageUsed, 0).toFixed(4)),
      storageBreakdown: nextBreakdown,
    };
  } catch {
    return {
      storageused: 0,
      storageBreakdown: APP_STORAGE_SOURCES.map((app) => ({ key: app.key, label: app.label, color: app.color, active: false, storageUsed: 0 })),
    };
  }
}

app.get('/auth/me', requireSession, async (req, res) => {
  try {
    const { uid, email } = req.session;
    const fbAdmin = getFirebaseAdmin(config.firebaseServiceAccountPath);
    const db = fbAdmin.firestore();
    const userRef = db.collection('users').doc(uid);
    const userSnapshot = await userRef.get();
    const user = userSnapshot.exists ? userSnapshot.data() || {} : {};
    const profilePhotoUrl = user?.profilePhoto?.url || user?.picture || '';
    const needsProfilePhoto = !profilePhotoUrl;
    const plan = typeof user?.plan === 'string' && user.plan ? user.plan : 'basic';
    const storage = typeof user?.storage === 'number' && Number.isFinite(user.storage) ? user.storage : 1024;
    const photosMetaSnapshot = await userRef.collection('photos').doc('meta').get();
    const photosMeta = photosMetaSnapshot.exists ? photosMetaSnapshot.data() || {} : {};
    const { storageused, storageBreakdown } = await readAppStorageBreakdown(userRef, uid, user, { exact: false });
    if (typeof user?.storageused !== 'undefined') {
      userRef.update({ storageused: fbAdmin.firestore.FieldValue.delete() }).catch(() => {});
    }
    const dashboardAccentColor = typeof user?.ui?.dashboardAccentColor === 'string' ? user.ui.dashboardAccentColor : '';
    const birthDate = typeof user?.birthDate === 'string' ? user.birthDate : '';
    const countryCode = typeof user?.countryCode === 'string' ? user.countryCode : '';
    const provider = typeof user?.provider === 'string'
      ? user.provider
      : (typeof user?.firebase?.signInProvider === 'string' ? user.firebase.signInProvider : '');
    const createdAtRaw = user?.createdAt;
    const createdAt = createdAtRaw && typeof createdAtRaw?.toDate === 'function'
      ? createdAtRaw.toDate().toISOString()
      : (typeof createdAtRaw === 'string' ? createdAtRaw : '');
    const lastLoginAtRaw = user?.lastLoginAt;
    const lastLoginAt = lastLoginAtRaw && typeof lastLoginAtRaw?.toDate === 'function'
      ? lastLoginAtRaw.toDate().toISOString()
      : (typeof lastLoginAtRaw === 'string' ? lastLoginAtRaw : '');
    const profilePhotoUpdatedAtRaw = user?.profilePhoto?.updatedAt;
    const profilePhotoUpdatedAt = profilePhotoUpdatedAtRaw && typeof profilePhotoUpdatedAtRaw?.toDate === 'function'
      ? profilePhotoUpdatedAtRaw.toDate().toISOString()
      : (typeof profilePhotoUpdatedAtRaw === 'string' ? profilePhotoUpdatedAtRaw : '');
    const lastLoginBy = typeof user?.lastLoginBy === 'string' && user.lastLoginBy
      ? user.lastLoginBy
      : provider;
    let countryName = '';
    try {
      countryName = countryCode && Intl?.DisplayNames
        ? new Intl.DisplayNames(['en'], { type: 'region' }).of(countryCode) || ''
        : '';
    } catch {
      countryName = '';
    }

    res.json({
      ok: true,
      uid,
      email,
      name: user?.name || '',
      firstName: user?.firstName || '',
      middleName: user?.middleName || '',
      lastName: user?.lastName || '',
      birthDate,
      dob: birthDate,
      countryCode,
      countryName,
      provider,
      createdAt,
      lastLoginBy,
      lastLoginAt,
      profilePhotoUrl,
      profilePhotoUpdatedAt,
      needsProfilePhoto,
      plan,
      storage,
      storageused,
      photosCount: typeof photosMeta?.photosCount === 'number' ? photosMeta.photosCount : 0,
      videosCount: typeof photosMeta?.videosCount === 'number' ? photosMeta.videosCount : 0,
      itemsCount: typeof photosMeta?.itemsCount === 'number' ? photosMeta.itemsCount : 0,
      storageBreakdown,
      dashboardAccentColor,
    });
  } catch (error) {
    res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to load session' });
  }
});

app.get('/storage/refresh', requireSession, storageRefreshLimiter, async (req, res) => {
  try {
    const { uid, email } = req.session;
    const fbAdmin = getFirebaseAdmin(config.firebaseServiceAccountPath);
    const db = fbAdmin.firestore();
    const userRef = db.collection('users').doc(uid);
    const userSnapshot = await userRef.get();
    const user = userSnapshot.exists ? userSnapshot.data() || {} : {};
    const profilePhotoUrl = user?.profilePhoto?.url || user?.picture || '';
    const needsProfilePhoto = !profilePhotoUrl;
    const plan = typeof user?.plan === 'string' && user.plan ? user.plan : 'basic';
    const storage = typeof user?.storage === 'number' && Number.isFinite(user.storage) ? user.storage : 1024;
    const { storageused, storageBreakdown } = await readAppStorageBreakdown(userRef, uid, user, { exact: true });
    if (typeof user?.storageused !== 'undefined') {
      userRef.update({ storageused: fbAdmin.firestore.FieldValue.delete() }).catch(() => {});
    }
    const dashboardAccentColor = typeof user?.ui?.dashboardAccentColor === 'string' ? user.ui.dashboardAccentColor : '';
    const birthDate = typeof user?.birthDate === 'string' ? user.birthDate : '';
    const countryCode = typeof user?.countryCode === 'string' ? user.countryCode : '';
    const provider = typeof user?.provider === 'string'
      ? user.provider
      : (typeof user?.firebase?.signInProvider === 'string' ? user.firebase.signInProvider : '');
    const createdAtRaw = user?.createdAt;
    const createdAt = createdAtRaw && typeof createdAtRaw?.toDate === 'function'
      ? createdAtRaw.toDate().toISOString()
      : (typeof createdAtRaw === 'string' ? createdAtRaw : '');
    const lastLoginAtRaw = user?.lastLoginAt;
    const lastLoginAt = lastLoginAtRaw && typeof lastLoginAtRaw?.toDate === 'function'
      ? lastLoginAtRaw.toDate().toISOString()
      : (typeof lastLoginAtRaw === 'string' ? lastLoginAtRaw : '');
    const profilePhotoUpdatedAtRaw = user?.profilePhoto?.updatedAt;
    const profilePhotoUpdatedAt = profilePhotoUpdatedAtRaw && typeof profilePhotoUpdatedAtRaw?.toDate === 'function'
      ? profilePhotoUpdatedAtRaw.toDate().toISOString()
      : (typeof profilePhotoUpdatedAtRaw === 'string' ? profilePhotoUpdatedAtRaw : '');
    const lastLoginBy = typeof user?.lastLoginBy === 'string' && user.lastLoginBy
      ? user.lastLoginBy
      : provider;
    let countryName = '';
    try {
      countryName = countryCode && Intl?.DisplayNames
        ? new Intl.DisplayNames(['en'], { type: 'region' }).of(countryCode) || ''
        : '';
    } catch {
      countryName = '';
    }

    res.json({
      ok: true,
      uid,
      email,
      name: user?.name || '',
      firstName: user?.firstName || '',
      middleName: user?.middleName || '',
      lastName: user?.lastName || '',
      birthDate,
      dob: birthDate,
      countryCode,
      countryName,
      provider,
      createdAt,
      lastLoginBy,
      lastLoginAt,
      profilePhotoUrl,
      profilePhotoUpdatedAt,
      needsProfilePhoto,
      plan,
      storage,
      storageused,
      storageBreakdown,
      dashboardAccentColor,
    });
  } catch (error) {
    res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to refresh storage' });
  }
});

app.post('/users/me/profile-photo', requireSession, upload.single('photo'), async (req, res) => {
  try {
    ensureCloudinaryConfigured();

    const file = req.file;
    if (!file?.buffer) return res.status(400).json({ ok: false, error: 'Missing photo file' });
    if (!file.mimetype?.startsWith('image/')) return res.status(400).json({ ok: false, error: 'File must be an image' });

    const { uid } = req.session;

    const fbAdmin = getFirebaseAdmin(config.firebaseServiceAccountPath);
    const db = fbAdmin.firestore();
    const userRef = db.collection('users').doc(uid);
    const userSnapshot = await userRef.get();
    const user = userSnapshot.exists ? userSnapshot.data() || {} : {};
    const previousPublicId = user?.profilePhoto?.publicId || null;
    await assertStorageCapacity({
      firebaseServiceAccountPath: config.firebaseServiceAccountPath,
      uid,
      userRef,
      user,
      incomingStorageMb: toMbFromBytes(file.size),
      replacingStorageMb: readProfilePhotoStorageMb(user),
      useSupabaseForNotes,
      useSupabaseForContacts,
    });

    const uploadResult = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: 'iclora/profile-photos',
          public_id: `${uid}-${Date.now()}`,
          overwrite: true,
          resource_type: 'image',
        },
        (error, result) => {
          if (error) return reject(error);
          return resolve(result);
        }
      );
      uploadStream.end(file.buffer);
    });

    const secureUrl = uploadResult?.secure_url || '';
    const publicId = uploadResult?.public_id || '';
    const photoBytes = Number(uploadResult?.bytes || file.size || 0);
    if (!secureUrl) return res.status(500).json({ ok: false, error: 'Upload failed' });

    const profilePhotoUpdatedAt = new Date().toISOString();

    await userRef.set(
      {
        picture: secureUrl,
        profilePhoto: {
          url: secureUrl,
          publicId,
          bytes: photoBytes,
          updatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
        },
      },
      { merge: true }
    );

    const storage = typeof user?.storage === 'number' && Number.isFinite(user.storage) ? user.storage : 1024;
    const { storageused, storageBreakdown } = await readAppStorageBreakdown(userRef, uid, {
      ...user,
      profilePhoto: {
        ...(user?.profilePhoto || {}),
        url: secureUrl,
        publicId,
        bytes: photoBytes,
      },
    }, { exact: false });

    if (previousPublicId && previousPublicId !== publicId) {
      try {
        await cloudinary.uploader.destroy(previousPublicId, { resource_type: 'image' });
      } catch {
      }
    }

    sendSettingsAlert({
      config,
      uid,
      email: req.session?.email || user?.email || '',
      user: {
        ...user,
        picture: secureUrl,
        profilePhoto: {
          ...(user?.profilePhoto || {}),
          url: secureUrl,
          publicId,
          bytes: photoBytes,
          updatedAt: profilePhotoUpdatedAt,
        },
      },
      title: 'Profile photo updated',
      summary: 'Your iClora profile photo was changed.',
      changes: [
        { label: 'Profile photo', value: `Last updated on ${formatSettingsDateTime(profilePhotoUpdatedAt)}` },
      ],
    });

    res.json({
      ok: true,
      url: secureUrl,
      profilePhotoUrl: secureUrl,
      profilePhotoUpdatedAt,
      needsProfilePhoto: false,
      storage,
      storageused,
      storageBreakdown,
    });
  } catch (error) {
    res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Profile photo upload failed' });
  }
});

app.post('/auth/logout', (req, res) => {
  const authHeader = req.get('authorization') || '';
  const bearerToken = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  const token = req.cookies?.[config.cookieName] || bearerToken;

  clearSessionCookie(req, res);
  res.json({ ok: true });

  if (token && config.jwtSecret) {
    queueMicrotask(async () => {
      try {
        const decoded = jwt.verify(token, config.jwtSecret, {
          issuer: config.jwtIssuer,
          audience: config.jwtAudience,
        });
        const sessionId = getSessionIdFromDecoded(decoded) || getLegacySessionId(token);
        if (decoded?.uid && sessionId) {
          await expireSessionActivity({
            config,
            uid: decoded.uid,
            sessionId,
            reason: 'logout',
            req,
          });
        }
      } catch {
        // Cookie/local cleanup should still happen even when the token is stale.
      }
    });
  }
});

const server = app.listen(config.port, config.host, () => {
  console.log(`iClora backend listening on ${config.host}:${config.port}`);
});

server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use. Stop the old process or change PORT in backend/.env.`);
    process.exit(1);
  }

  throw error;
});
