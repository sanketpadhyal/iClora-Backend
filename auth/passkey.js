import express from 'express';
import jwt from 'jsonwebtoken';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { getFirebaseAdmin } from '../firebase.js';
import { sendPasskeyLoginAlert } from '../alerts-mails/authmail.js';
import { sendSettingsAlert } from '../alerts-mails/settingsmail.js';

const AUTH_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_PASSKEYS_PER_ACCOUNT = 4;

function toBase64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Url(value) {
  return Buffer.from(String(value || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function getOrigins(frontendOrigin = '') {
  return frontendOrigin
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function getRpID(origin = '') {
  if (!origin) return 'localhost';
  try {
    const url = new URL(origin);
    return url.hostname;
  } catch {
    return 'localhost';
  }
}

function getRequestRpID(origin = '', fallbackOrigin = '') {
  const resolvedOrigin = String(origin || '').trim() || String(fallbackOrigin || '').split(',')[0]?.trim() || '';
  return getRpID(resolvedOrigin);
}

function sanitizeErrorMessage(msg) {
  if (!msg) return '';
  const s = String(msg);
  const seeIndex = s.indexOf('See:');
  if (seeIndex !== -1) return s.slice(0, seeIndex).trim();
  // Remove any trailing URLs
  return s.replace(/https?:\/\/\S+/g, '').trim();
}

function normalizePasskeyName(value) {
  const name = String(value || '').replace(/\s+/g, ' ').trim();
  return name.slice(0, 40);
}

function cleanProfileText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function getUserDisplayName(user = {}, authUser = {}) {
  const joinedName = [user?.firstName, user?.middleName, user?.lastName]
    .map((part) => cleanProfileText(part))
    .filter(Boolean)
    .join(' ');

  return cleanProfileText(
    user?.name
      || user?.displayName
      || user?.fullName
      || joinedName
      || authUser?.displayName
  );
}

function getUserProfilePhotoUrl(user = {}, authUser = {}) {
  return cleanProfileText(
    user?.profilePhoto?.url
      || user?.profilePhotoUrl
      || user?.picture
      || user?.photoURL
      || authUser?.photoURL
  );
}

function getDeviceName(userAgent = '') {
  const ua = String(userAgent || '');
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android device';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows PC';
  if (/Linux/i.test(ua)) return 'Linux device';
  return 'Trusted device';
}

function toStoredCredential(credential, info, req, name = '') {
  const userAgent = req.get('user-agent') || '';
  return {
    id: credential.id,
    name: normalizePasskeyName(name) || 'iClora Passkey',
    publicKey: toBase64Url(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports || [],
    deviceType: info.credentialDeviceType || '',
    backedUp: Boolean(info.credentialBackedUp),
    createdAt: new Date().toISOString(),
    lastUsedAt: '',
    lastLoginBy: '',
    deviceName: getDeviceName(userAgent),
    userAgent,
  };
}

function toVerifyCredential(stored) {
  return {
    id: stored.id,
    publicKey: new Uint8Array(fromBase64Url(stored.publicKey)),
    counter: Number.isFinite(Number(stored.counter)) ? Number(stored.counter) : 0,
    transports: Array.isArray(stored.transports) ? stored.transports : [],
  };
}

function buildPasskeySummary(doc = {}) {
  const passkeys = Array.isArray(doc.passkeys) ? doc.passkeys : [];
  return passkeys.map((passkey) => ({
    id: passkey.id,
    name: passkey.name || '',
    createdAt: passkey.createdAt || '',
    lastUsedAt: passkey.lastUsedAt || '',
    lastLoginBy: passkey.lastLoginBy || '',
    deviceName: passkey.deviceName || getDeviceName(passkey.userAgent),
    deviceType: passkey.deviceType || '',
    backedUp: Boolean(passkey.backedUp),
    transports: Array.isArray(passkey.transports) ? passkey.transports : [],
  }));
}

export default function createPasskeyRouter({
  config,
  requireSession,
  authLimiter,
  signSessionJwt,
  sessionMaxAgeMs,
  getCookiePolicyForOrigin,
  recordLoginActivity,
}) {
  const router = express.Router();
  const publicAuthLimiter = typeof authLimiter === 'function' ? authLimiter : (_req, _res, next) => next();
  const rpName = 'iClora';
  const expectedOrigin = getOrigins(config.frontendOrigin);
  const fallbackRpID = getRpID(getOrigins(config.frontendOrigin)[0] || '');

  function signPasskeyChallenge(challenge) {
    if (!config.jwtSecret) throw new Error('JWT_SECRET is missing');
    return jwt.sign(
      { purpose: 'passkey-auth', challenge },
      config.jwtSecret,
      {
        algorithm: 'HS256',
        expiresIn: '5m',
        issuer: config.jwtIssuer,
        audience: config.jwtAudience,
      }
    );
  }

  function verifyPasskeyChallenge(token) {
    if (!config.jwtSecret) throw new Error('JWT_SECRET is missing');
    const decoded = jwt.verify(token, config.jwtSecret, {
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
    });
    if (decoded?.purpose !== 'passkey-auth' || typeof decoded?.challenge !== 'string') {
      throw new Error('Invalid passkey challenge');
    }
    return decoded.challenge;
  }

  router.get('/passkey/me', requireSession, async (req, res) => {
    try {
      const fbAdmin = getFirebaseAdmin(config.firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const { uid } = req.session;
      const snapshot = await db.collection('passkey').doc(uid).get();
      const data = snapshot.exists ? snapshot.data() || {} : {};
      res.json({
        ok: true,
        uid,
        email: data.email || req.session.email || '',
        passkeys: buildPasskeySummary(data),
        lastLogin: data.lastLogin || null,
      });
    } catch (error) {
      const msg = sanitizeErrorMessage(error?.message) || 'Could not load passkeys';
      res.status(400).json({ ok: false, error: msg });
    }
  });

  router.delete('/passkey/:credentialId', requireSession, async (req, res) => {
    try {
      const credentialId = String(req.params.credentialId || '').trim();
      if (!credentialId) {
        return res.status(400).json({ ok: false, error: 'Missing passkey id' });
      }

      const fbAdmin = getFirebaseAdmin(config.firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const { uid, email } = req.session;
      const docRef = db.collection('passkey').doc(uid);
      const snapshot = await docRef.get();
      const data = snapshot.exists ? snapshot.data() || {} : {};
      const passkeys = Array.isArray(data.passkeys) ? data.passkeys : [];
      const deletedPasskey = passkeys.find((passkey) => passkey.id === credentialId);
      const passkeyExists = Boolean(deletedPasskey);

      if (!passkeyExists) {
        return res.status(404).json({ ok: false, error: 'Passkey not found' });
      }

      const nextPasskeys = passkeys.filter((passkey) => passkey.id !== credentialId);
      await docRef.set({
        uid,
        email: data.email || email || '',
        credentialIds: nextPasskeys.map((passkey) => passkey.id),
        passkeys: nextPasskeys,
        updatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      sendSettingsAlert({
        config,
        uid,
        email: email || data.email || '',
        passkeys: nextPasskeys,
        title: 'Passkey deleted',
        summary: 'A passkey was removed from your iClora account.',
        changes: [
          { label: 'Deleted passkey', value: deletedPasskey?.name || deletedPasskey?.deviceName || 'Passkey' },
        ],
      });

      res.json({ ok: true, passkeys: buildPasskeySummary({ passkeys: nextPasskeys }) });
    } catch (error) {
      const msg = sanitizeErrorMessage(error?.message) || 'Could not delete passkey';
      res.status(400).json({ ok: false, error: msg });
    }
  });

  router.post('/passkey/register/options', requireSession, async (req, res) => {
    try {
      const fbAdmin = getFirebaseAdmin(config.firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const { uid, email } = req.session;
      const snapshot = await db.collection('passkey').doc(uid).get();
      const data = snapshot.exists ? snapshot.data() || {} : {};
      const existingPasskeys = Array.isArray(data.passkeys) ? data.passkeys : [];
      if (existingPasskeys.length >= MAX_PASSKEYS_PER_ACCOUNT) {
        return res.status(409).json({
          ok: false,
          error: `You can save up to ${MAX_PASSKEYS_PER_ACCOUNT} passkeys for one iClora account.`,
        });
      }
      const options = await generateRegistrationOptions({
        rpName,
        rpID: getRequestRpID(req.headers.origin || '', config.frontendOrigin || fallbackRpID),
        userID: new TextEncoder().encode(uid),
        userName: email || uid,
        userDisplayName: email || uid,
        timeout: 60000,
        attestationType: 'none',
        excludeCredentials: existingPasskeys.map((passkey) => ({
          id: passkey.id,
          transports: Array.isArray(passkey.transports) ? passkey.transports : [],
        })),
        authenticatorSelection: {
          residentKey: 'required',
          requireResidentKey: true,
          userVerification: 'required',
        },
      });

      await db.collection('passkey').doc(uid).set({
        uid,
        email: email || '',
        registrationChallenge: options.challenge,
        registrationChallengeExpiresAt: Date.now() + AUTH_CHALLENGE_TTL_MS,
        updatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      res.json({ ok: true, options });
    } catch (error) {
      const msg = sanitizeErrorMessage(error?.message) || 'Could not start passkey setup';
      res.status(400).json({ ok: false, error: msg });
    }
  });

  router.post('/passkey/register/verify', requireSession, async (req, res) => {
    try {
      const fbAdmin = getFirebaseAdmin(config.firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const { uid, email } = req.session;
      const response = req.body?.response;
      const passkeyName = normalizePasskeyName(req.body?.name);
      const docRef = db.collection('passkey').doc(uid);
      const snapshot = await docRef.get();
      const data = snapshot.exists ? snapshot.data() || {} : {};
      const expectedChallenge = data.registrationChallenge || '';
      const challengeExpiresAt = Number(data.registrationChallengeExpiresAt || 0);
      if (!expectedChallenge || Date.now() > challengeExpiresAt) {
        return res.status(400).json({ ok: false, error: 'Passkey setup expired. Please try again.' });
      }

      const verification = await verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin,
        expectedRPID: getRequestRpID(req.headers.origin || '', config.frontendOrigin || fallbackRpID),
        requireUserVerification: true,
      });

      if (!verification.verified || !verification.registrationInfo?.credential) {
        return res.status(400).json({ ok: false, error: 'Passkey setup could not be verified' });
      }

      const existingPasskeys = Array.isArray(data.passkeys) ? data.passkeys : [];
      const credential = verification.registrationInfo.credential;
      const isExistingCredential = existingPasskeys.some((passkey) => passkey.id === credential.id);
      if (!isExistingCredential && existingPasskeys.length >= MAX_PASSKEYS_PER_ACCOUNT) {
        return res.status(409).json({
          ok: false,
          error: `You can save up to ${MAX_PASSKEYS_PER_ACCOUNT} passkeys for one iClora account.`,
        });
      }
      const duplicateSnapshot = await db.collection('passkey')
        .where('credentialIds', 'array-contains', credential.id)
        .limit(1)
        .get();
      if (!duplicateSnapshot.empty && duplicateSnapshot.docs[0].id !== uid) {
        return res.status(409).json({
          ok: false,
          error: 'This passkey is already registered with a different iClora account.',
        });
      }

      const nextPasskeys = [
        ...existingPasskeys.filter((passkey) => passkey.id !== credential.id),
        toStoredCredential(credential, verification.registrationInfo, req, passkeyName),
      ];

      await docRef.set({
        uid,
        email: email || data.email || '',
        credentialIds: nextPasskeys.map((passkey) => passkey.id),
        passkeys: nextPasskeys,
        registrationChallenge: '',
        registrationChallengeExpiresAt: 0,
        updatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      const addedPasskey = nextPasskeys.find((passkey) => passkey.id === credential.id) || {};
      sendSettingsAlert({
        config,
        uid,
        email: email || data.email || '',
        passkeys: nextPasskeys,
        title: 'Passkey added',
        summary: 'A new passkey was added to your iClora account.',
        changes: [
          { label: 'New passkey', value: addedPasskey.name || passkeyName || 'iClora Passkey' },
          { label: 'Device', value: addedPasskey.deviceName || getDeviceName(req.get('user-agent') || '') },
        ],
      });

      res.json({ ok: true, passkeys: buildPasskeySummary({ passkeys: nextPasskeys }) });
    } catch (error) {
      const msg = sanitizeErrorMessage(error?.message) || 'Could not verify passkey setup';
      res.status(400).json({ ok: false, error: msg });
    }
  });

  router.post('/auth/passkey/options', publicAuthLimiter, async (_req, res) => {
    try {
      const options = await generateAuthenticationOptions({
        rpID: getRequestRpID(_req.headers.origin || '', config.frontendOrigin || fallbackRpID),
        timeout: 60000,
        userVerification: 'required',
      });
      const challengeId = signPasskeyChallenge(options.challenge);
      res.json({ ok: true, challengeId, options });
    } catch (error) {
      const msg = sanitizeErrorMessage(error?.message) || 'Could not start passkey sign-in';
      res.status(400).json({ ok: false, error: msg });
    }
  });

  router.post('/auth/passkey/verify', publicAuthLimiter, async (req, res) => {
    try {
      const { challengeId, response } = req.body || {};
      const credentialId = response?.id;
      if (!challengeId || !credentialId) {
        return res.status(400).json({ ok: false, error: 'Missing passkey response' });
      }

      const fbAdmin = getFirebaseAdmin(config.firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      let expectedChallenge = '';
      try {
        expectedChallenge = verifyPasskeyChallenge(challengeId);
      } catch {
        return res.status(400).json({ ok: false, error: 'Passkey sign-in expired. Please try again.' });
      }

      const credentialSnapshot = await db.collection('passkey')
        .where('credentialIds', 'array-contains', credentialId)
        .limit(1)
        .get();
      if (credentialSnapshot.empty) {
        return res.status(401).json({ ok: false, error: 'Passkey is not registered with iClora' });
      }

      const passkeyDoc = credentialSnapshot.docs[0];
      const passkeyData = passkeyDoc.data() || {};
      const passkeys = Array.isArray(passkeyData.passkeys) ? passkeyData.passkeys : [];
      const storedCredential = passkeys.find((passkey) => passkey.id === credentialId);
      if (!storedCredential) {
        return res.status(401).json({ ok: false, error: 'Passkey is not registered with iClora' });
      }

      const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin,
        expectedRPID: getRequestRpID(req.headers.origin || '', config.frontendOrigin || fallbackRpID),
        credential: toVerifyCredential(storedCredential),
        requireUserVerification: true,
      });

      if (!verification.verified) {
        return res.status(401).json({ ok: false, error: 'Passkey sign-in could not be verified' });
      }

      const uid = passkeyData.uid || passkeyDoc.id;
      const userSnapshot = await db.collection('users').doc(uid).get();
      const user = userSnapshot.exists ? userSnapshot.data() || {} : {};
      const authUser = await fbAdmin.auth().getUser(uid).catch(() => null);
      const email = passkeyData.email || user.email || authUser?.email || '';
      const displayName = getUserDisplayName(user, authUser || {});
      const profilePhotoUrl = getUserProfilePhotoUrl(user, authUser || {});
      const nowIso = new Date().toISOString();
      const nextPasskeys = passkeys.map((passkey) => (
        passkey.id === credentialId
          ? {
            ...passkey,
            counter: verification.authenticationInfo.newCounter,
            lastUsedAt: nowIso,
            lastLoginBy: 'passkey',
            deviceType: verification.authenticationInfo.credentialDeviceType || passkey.deviceType || '',
            backedUp: Boolean(verification.authenticationInfo.credentialBackedUp),
          }
          : passkey
      ));

      await passkeyDoc.ref.set({
        passkeys: nextPasskeys,
        lastLogin: {
          by: 'passkey',
          credentialId,
          at: nowIso,
          userAgent: req.get('user-agent') || '',
        },
        updatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      await db.collection('users').doc(uid).set({
        lastLoginAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
        lastLoginBy: 'passkey',
      }, { merge: true });

      const sessionJwt = signSessionJwt({ uid, email });
      const decodedSession = jwt.decode(sessionJwt) || {};
      const sessionId = decodedSession.sid || decodedSession.jti || '';
      const sessionExpiresAt = Date.now() + sessionMaxAgeMs;
      if (typeof recordLoginActivity === 'function') {
        const loginSession = await recordLoginActivity({
          config,
          uid,
          email,
          sessionId,
          provider: 'passkey',
          req,
          expiresAtMs: sessionExpiresAt,
        });
        sendPasskeyLoginAlert({
          email,
          name: displayName,
          profilePhotoUrl,
          user: {
            ...user,
            email,
            name: displayName,
            profilePhotoUrl,
            photoURL: authUser?.photoURL || '',
            displayName: authUser?.displayName || '',
          },
          loginAt: nowIso,
          session: loginSession,
        });
      }
      const cookiePolicy = getCookiePolicyForOrigin(req.headers.origin || '');
      res.cookie(config.cookieName, sessionJwt, {
        httpOnly: true,
        sameSite: cookiePolicy.sameSite,
        secure: cookiePolicy.secure,
        maxAge: sessionMaxAgeMs,
        path: '/',
      });

      res.json({
        ok: true,
        uid,
        email,
        sessionToken: sessionJwt,
        sessionExpiresAt,
        sessionId,
        lastLoginBy: 'passkey',
      });
    } catch (error) {
      const msg = sanitizeErrorMessage(error?.message) || 'Could not complete passkey sign-in';
      res.status(400).json({ ok: false, error: msg });
    }
  });

  return router;
}
