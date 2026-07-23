import express from 'express';
import { getFirebaseAdmin } from '../firebase.js';

export const LOGIN_ACTIVITY_COLLECTION = 'login activity';
export const SESSION_ACTIVE_COLLECTION = 'session active';
export const SESSION_EXPIRED_COLLECTION = 'session expired';

function getDb(config) {
  return getFirebaseAdmin(config.firebaseServiceAccountPath).firestore();
}

function getActivityRoot(db, uid) {
  return db.collection(LOGIN_ACTIVITY_COLLECTION).doc(uid);
}

function getSessionRefs(db, uid, sessionId) {
  const root = getActivityRoot(db, uid);
  return {
    root,
    activeRef: root.collection(SESSION_ACTIVE_COLLECTION).doc(sessionId),
    expiredRef: root.collection(SESSION_EXPIRED_COLLECTION).doc(sessionId),
  };
}

function getClientIp(req) {
  const forwarded = String(req.get('x-forwarded-for') || '').split(',')[0]?.trim();
  return forwarded || req.ip || req.socket?.remoteAddress || '';
}

function firstHeader(req, keys = []) {
  for (const key of keys) {
    const value = String(req?.get?.(key) || '').trim();
    if (value) return value;
  }
  return '';
}

function getApproxLocation(req) {
  const city = firstHeader(req, [
    'x-vercel-ip-city',
    'cf-ipcity',
    'x-appengine-city',
    'x-geo-city',
    'x-city',
  ]);
  const region = firstHeader(req, [
    'x-vercel-ip-country-region',
    'cf-region',
    'x-appengine-region',
    'x-geo-region',
    'x-region',
    'x-state',
  ]);
  const country = firstHeader(req, [
    'x-vercel-ip-country',
    'cf-ipcountry',
    'x-appengine-country',
    'x-geo-country',
    'x-country',
  ]);

  const parts = [city, region, country].filter(Boolean);
  return {
    city,
    region,
    country,
    label: parts.join(', '),
  };
}

function getBrowserName(userAgent = '') {
  const ua = String(userAgent || '');
  if (/Edg\//i.test(ua)) return 'Microsoft Edge';
  if (/OPR\//i.test(ua)) return 'Opera';
  if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) return 'Chrome';
  if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) return 'Safari';
  if (/Firefox\//i.test(ua)) return 'Firefox';
  return 'Browser';
}

function getOsName(userAgent = '') {
  const ua = String(userAgent || '');
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
  if (/Android/i.test(ua)) return 'Android';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Unknown OS';
}

function getDeviceType(userAgent = '') {
  const ua = String(userAgent || '');
  if (/Mobile|iPhone|Android/i.test(ua)) return 'mobile';
  if (/iPad|Tablet/i.test(ua)) return 'tablet';
  return 'desktop';
}

function getApplicationClientInfo(req, userAgent = '') {
  const client = String(req?.get?.('x-iclora-client') || '').trim().toLowerCase();
  if (client !== 'application' && client !== 'mobile') return null;

  const platform = String(req?.get?.('x-iclora-platform') || '').trim().toLowerCase();
  const osName = platform === 'ios' ? 'iOS' : platform === 'android' ? 'Android' : getOsName(userAgent);

  return {
    deviceName: osName && osName !== 'Unknown OS' ? `iClora ${osName} App` : 'iClora App',
    deviceType: osName === 'iOS' || osName === 'Android' ? 'mobile' : getDeviceType(userAgent),
    browserName: 'iClora App',
    osName,
  };
}

function isApplicationSessionData(data = {}) {
  const clientType = String(data.clientType || '').trim().toLowerCase();
  const browserName = String(data.browserName || '').trim().toLowerCase();
  const deviceName = String(data.deviceName || '').trim().toLowerCase();
  const loginAtMs = Date.parse(data.loginAtIso || '') || 0;
  const expiresAtMs = Number(data.expiresAtMs || 0);
  const looksLikeAppLifetime = loginAtMs > 0 && expiresAtMs - loginAtMs > 8 * 60 * 60 * 1000;
  return clientType === 'application'
    || clientType === 'mobile'
    || browserName === 'iclora app'
    || deviceName.includes('iclora android app')
    || deviceName.includes('iclora ios app')
    || deviceName === 'iclora app'
    || looksLikeAppLifetime;
}

export function getDeviceName(userAgent = '') {
  const osName = getOsName(userAgent);
  const browserName = getBrowserName(userAgent);
  if (osName === 'Unknown OS') return browserName;
  return `${browserName} on ${osName}`;
}

function toIso(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value?.toDate === 'function') return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return '';
}

function normalizeSessionDoc(snapshot, status, currentSessionId = '') {
  const data = snapshot.data() || {};
  const sessionId = data.sessionId || snapshot.id;
  const isApplicationSession = isApplicationSessionData(data);
  return {
    sessionId,
    status,
    current: Boolean(currentSessionId && sessionId === currentSessionId),
    uid: data.uid || '',
    email: data.email || '',
    provider: data.provider || '',
    clientType: isApplicationSession ? 'application' : data.clientType || 'web',
    deviceName: data.deviceName || (isApplicationSession ? 'iClora App' : getDeviceName(data.userAgent)),
    deviceType: isApplicationSession ? 'mobile' : data.deviceType || getDeviceType(data.userAgent),
    browserName: isApplicationSession ? 'iClora App' : data.browserName || getBrowserName(data.userAgent),
    osName: data.osName || getOsName(data.userAgent),
    ip: data.ip || '',
    locationCity: data.locationCity || '',
    locationRegion: data.locationRegion || '',
    locationCountry: data.locationCountry || '',
    locationLabel: data.locationLabel || '',
    userAgent: data.userAgent || '',
    loginAt: data.loginAtIso || toIso(data.loginAt),
    lastSeenAt: data.lastSeenAtIso || toIso(data.lastSeenAt),
    logoutAt: data.logoutAtIso || toIso(data.logoutAt),
    expiresAt: data.expiresAtIso || toIso(data.expiresAt),
    expiresAtMs: Number(data.expiresAtMs || 0),
    reason: data.reason || '',
  };
}

function sortSessions(sessions) {
  return sessions.sort((a, b) => {
    const aTime = Date.parse(a.loginAt || a.logoutAt || '') || 0;
    const bTime = Date.parse(b.loginAt || b.logoutAt || '') || 0;
    return bTime - aTime;
  });
}

export function getSessionIdFromDecoded(decoded = {}) {
  return decoded.sid || decoded.jti || '';
}

export async function recordLoginActivity({
  config,
  uid,
  email = '',
  sessionId,
  provider = '',
  req,
  expiresAtMs,
}) {
  if (!uid || !sessionId) return null;

  const fbAdmin = getFirebaseAdmin(config.firebaseServiceAccountPath);
  const db = fbAdmin.firestore();
  const nowIso = new Date().toISOString();
  const userAgent = req?.get?.('user-agent') || '';
  const applicationClientInfo = getApplicationClientInfo(req, userAgent);
  const clientType = applicationClientInfo ? 'application' : 'web';
  const expiresAtDate = new Date(expiresAtMs);
  const { root, activeRef } = getSessionRefs(db, uid, sessionId);
  const location = getApproxLocation(req);

  const payload = {
    sessionId,
    uid,
    email,
    provider,
    status: 'active',
    clientType,
    deviceName: applicationClientInfo?.deviceName || getDeviceName(userAgent),
    deviceType: applicationClientInfo?.deviceType || getDeviceType(userAgent),
    browserName: applicationClientInfo?.browserName || getBrowserName(userAgent),
    osName: applicationClientInfo?.osName || getOsName(userAgent),
    ip: getClientIp(req),
    locationCity: location.city,
    locationRegion: location.region,
    locationCountry: location.country,
    locationLabel: location.label,
    userAgent,
    loginAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
    loginAtIso: nowIso,
    lastSeenAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
    lastSeenAtIso: nowIso,
    expiresAt: fbAdmin.firestore.Timestamp.fromDate(expiresAtDate),
    expiresAtIso: expiresAtDate.toISOString(),
    expiresAtMs,
    reason: '',
  };

  const batch = db.batch();
  batch.set(root, {
    uid,
    email,
    updatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  batch.set(activeRef, payload, { merge: true });
  await batch.commit();
  return payload;
}

export async function expireSessionActivity({
  config,
  uid,
  sessionId,
  reason = 'logout',
  req,
}) {
  if (!uid || !sessionId) return false;

  const fbAdmin = getFirebaseAdmin(config.firebaseServiceAccountPath);
  const db = fbAdmin.firestore();
  const nowIso = new Date().toISOString();
  const { root, activeRef, expiredRef } = getSessionRefs(db, uid, sessionId);
  const activeSnapshot = await activeRef.get();
  const activeData = activeSnapshot.exists ? activeSnapshot.data() || {} : {};

  const expiredPayload = {
    ...activeData,
    sessionId,
    uid,
    status: 'expired',
    reason,
    logoutAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
    logoutAtIso: nowIso,
    lastSeenAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
    lastSeenAtIso: nowIso,
  };

  if (!expiredPayload.userAgent && req?.get) {
    const userAgent = req.get('user-agent') || '';
    const location = getApproxLocation(req);
    expiredPayload.userAgent = userAgent;
    expiredPayload.deviceName = getDeviceName(userAgent);
    expiredPayload.deviceType = getDeviceType(userAgent);
    expiredPayload.browserName = getBrowserName(userAgent);
    expiredPayload.osName = getOsName(userAgent);
    expiredPayload.ip = getClientIp(req);
    expiredPayload.locationCity = location.city;
    expiredPayload.locationRegion = location.region;
    expiredPayload.locationCountry = location.country;
    expiredPayload.locationLabel = location.label;
  }

  const batch = db.batch();
  batch.set(root, {
    uid,
    email: expiredPayload.email || '',
    updatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  batch.set(expiredRef, expiredPayload, { merge: true });
  batch.delete(activeRef);
  await batch.commit();
  return true;
}

export async function sweepExpiredSessions({ config, uid, nowMs = Date.now(), limit = 50 }) {
  if (!uid) return 0;
  const db = getDb(config);
  const activeSnapshot = await getActivityRoot(db, uid)
    .collection(SESSION_ACTIVE_COLLECTION)
    .where('expiresAtMs', '<=', nowMs)
    .limit(limit)
    .get();

  if (activeSnapshot.empty) return 0;

  await Promise.all(activeSnapshot.docs.map((sessionDoc) => (
    expireSessionActivity({
      config,
      uid,
      sessionId: sessionDoc.id,
      reason: 'session_expired',
    })
  )));

  return activeSnapshot.size;
}

export async function ensureSessionIsActive({ config, uid, sessionId }) {
  if (!uid || !sessionId) return true;
  const db = getDb(config);
  const activeRef = getActivityRoot(db, uid).collection(SESSION_ACTIVE_COLLECTION).doc(sessionId);
  const activeSnapshot = await activeRef.get();
  if (!activeSnapshot.exists) return false;

  const data = activeSnapshot.data() || {};
  const expiresAtMs = Number(data.expiresAtMs || 0);
  if (expiresAtMs && expiresAtMs <= Date.now()) {
    await expireSessionActivity({
      config,
      uid,
      sessionId,
      reason: 'session_expired',
    });
    return false;
  }

  return data.status !== 'expired' && data.revoked !== true;
}

export async function hasExpiredSessionActivity({ config, uid, sessionId }) {
  if (!uid || !sessionId) return false;
  const db = getDb(config);
  const expiredSnapshot = await getActivityRoot(db, uid)
    .collection(SESSION_EXPIRED_COLLECTION)
    .doc(sessionId)
    .get();
  return expiredSnapshot.exists;
}

export async function getLoginActivity({ config, uid, currentSessionId = '' }) {
  if (!uid) return { active: [], expired: [] };
  await sweepExpiredSessions({ config, uid });

  const db = getDb(config);
  const root = getActivityRoot(db, uid);
  const [activeSnapshot, expiredSnapshot] = await Promise.all([
    root.collection(SESSION_ACTIVE_COLLECTION).get(),
    root.collection(SESSION_EXPIRED_COLLECTION).get(),
  ]);

  return {
    active: sortSessions(activeSnapshot.docs.map((doc) => normalizeSessionDoc(doc, 'active', currentSessionId))),
    expired: sortSessions(expiredSnapshot.docs.map((doc) => normalizeSessionDoc(doc, 'expired', currentSessionId))),
  };
}

export async function deleteExpiredSessionActivity({ config, uid, sessionId }) {
  if (!uid || !sessionId) return false;
  const fbAdmin = getFirebaseAdmin(config.firebaseServiceAccountPath);
  const db = fbAdmin.firestore();
  const { root, expiredRef } = getSessionRefs(db, uid, sessionId);
  const snapshot = await expiredRef.get();
  if (!snapshot.exists) return false;
  await Promise.all([
    expiredRef.delete(),
    root.set({ updatedAt: fbAdmin.firestore.FieldValue.serverTimestamp() }, { merge: true }),
  ]);
  return true;
}

export default function createAuthActivityRouter({ config, requireSession, clearSessionCookie }) {
  const router = express.Router();

  router.get('/auth/activity/sessions', requireSession, async (req, res) => {
    try {
      const activity = await getLoginActivity({
        config,
        uid: req.session.uid,
        currentSessionId: req.session.sessionId || '',
      });
      res.json({ ok: true, currentSessionId: req.session.sessionId || '', ...activity });
    } catch (error) {
      res.status(400).json({ ok: false, error: error?.message || 'Could not load login activity' });
    }
  });

  router.delete('/auth/activity/sessions/:sessionId', requireSession, async (req, res) => {
    try {
      const sessionId = String(req.params.sessionId || '').trim();
      if (!sessionId) return res.status(400).json({ ok: false, error: 'Missing session id' });

      await expireSessionActivity({
        config,
        uid: req.session.uid,
        sessionId,
        reason: sessionId === req.session.sessionId ? 'logout' : 'remote_logout',
        req,
      });

      const currentSessionEnded = sessionId === req.session.sessionId;
      if (currentSessionEnded && typeof clearSessionCookie === 'function') {
        clearSessionCookie(req, res);
      }

      res.json({ ok: true, currentSessionEnded });
    } catch (error) {
      res.status(400).json({ ok: false, error: error?.message || 'Could not log out device' });
    }
  });

  router.delete('/auth/activity/sessions/:sessionId/expired', requireSession, async (req, res) => {
    try {
      const sessionId = String(req.params.sessionId || '').trim();
      if (!sessionId) return res.status(400).json({ ok: false, error: 'Missing session id' });
      const deleted = await deleteExpiredSessionActivity({
        config,
        uid: req.session.uid,
        sessionId,
      });
      res.json({ ok: true, deleted });
    } catch (error) {
      res.status(400).json({ ok: false, error: error?.message || 'Could not delete expired session' });
    }
  });

  return router;
}
