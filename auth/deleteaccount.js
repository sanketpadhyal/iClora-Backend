import express from 'express';
import jwt from 'jsonwebtoken';
import { v2 as cloudinary } from 'cloudinary';
import { randomUUID } from 'crypto';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { getFirebaseAdmin } from '../firebase.js';
import { getSupabaseAdmin, hasSupabaseConfig } from '../supabase/client.js';

const DELETE_CONFIRMATION_PHRASE = 'DELETE MY ACCOUNT';
const RECENT_AUTH_MAX_AGE_MS = 5 * 60 * 1000;
const LOGIN_ACTIVITY_COLLECTION = 'login activity';
const SESSION_ACTIVE_COLLECTION = 'session active';
const SESSION_EXPIRED_COLLECTION = 'session expired';
const DELETE_PROOF_COLLECTION = 'delete account proofs';
const DELETED_ACCOUNT_FEEDBACK_COLLECTION = 'deleted account feedback';
const PHOTO_SHARE_LINKS_COLLECTION = 'photoShareLinks';
const PASSKEY_CHALLENGE_PURPOSE = 'delete-account-passkey-auth';
const DELETE_PROOF_PURPOSE = 'delete-account-proof';
const SUPABASE_USER_TABLES = [
  'notes_items',
  'notes_folders',
  'notes_meta',
  'contacts_items',
  'contacts_meta',
];
const DELETION_FEEDBACK_REASONS = new Map([
  ['app_issue', 'App issue'],
  ['app_crashing', 'App crashing on my device'],
  ['not_optimized', 'Website is not optimized for my device'],
  ['privacy_concern', 'Privacy or account concern'],
  ['not_useful', 'I do not use iClora anymore'],
  ['switching_service', 'I am switching to another service'],
  ['other', 'Other reason'],
]);

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
  return s.replace(/https?:\/\/\S+/g, '').trim();
}

function toVerifyCredential(stored) {
  return {
    id: stored.id,
    publicKey: new Uint8Array(fromBase64Url(stored.publicKey)),
    counter: Number.isFinite(Number(stored.counter)) ? Number(stored.counter) : 0,
    transports: Array.isArray(stored.transports) ? stored.transports : [],
  };
}

function configureCloudinary(config) {
  if (!config.cloudinaryCloudName || !config.cloudinaryApiKey || !config.cloudinaryApiSecret) return false;
  cloudinary.config({
    cloud_name: config.cloudinaryCloudName,
    api_key: config.cloudinaryApiKey,
    api_secret: config.cloudinaryApiSecret,
  });
  return true;
}

function uniqueStrings(values = []) {
  return Array.from(new Set(
    values
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean)
  ));
}

function isMissingSupabaseRelation(error) {
  return error?.code === '42P01';
}

async function readSupabaseContactPhotoPublicIds(uid) {
  if (!hasSupabaseConfig()) return [];
  try {
    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from('contacts_items')
      .select('photo_public_id')
      .eq('user_id', uid);
    if (error) return [];
    return uniqueStrings((data || []).map((row) => row?.photo_public_id));
  } catch {
    return [];
  }
}

async function deleteSupabaseUserData(uid) {
  if (!hasSupabaseConfig()) return;
  try {
    const sb = getSupabaseAdmin();
    for (const table of SUPABASE_USER_TABLES) {
      await sb.from(table).delete().eq('user_id', uid).catch(() => {});
    }
  } catch {
    // Account deletion should not fail if external database is unavailable.
  }
}

async function readFirestoreContactPhotoPublicIds(userRef) {
  try {
    const snapshot = await userRef.collection('contacts').select('photoPublicId').get();
    return uniqueStrings(snapshot.docs.map((doc) => doc.data()?.photoPublicId));
  } catch {
    return [];
  }
}

async function deleteCloudinaryAssetsForUser({ config, uid, publicIds = [] }) {
  if (!configureCloudinary(config)) return;

  const ids = uniqueStrings(publicIds);
  await Promise.all(ids.map(async (publicId) => {
    try {
      await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
    } catch {
      // Account deletion should continue if an asset was already removed.
    }
  }));

  const prefixes = [
    `iclora/profile-photos/${uid}-`,
    `iclora/contact-photos/${uid}-`,
    `iclora/photos/${uid}/`,
  ];
  await Promise.all(prefixes.map(async (prefix) => {
    try {
      await cloudinary.api.delete_resources_by_prefix(prefix, { resource_type: 'image' });
    } catch {
      // Stored public ids above are the primary cleanup path; prefixes catch strays.
    }

    try {
      await cloudinary.api.delete_resources_by_prefix(prefix, {
        resource_type: 'image',
        type: 'authenticated',
      });
    } catch {
      // Photos app uploads are authenticated; keep deletion best-effort.
    }
  }));
}

function signPasskeyChallenge(config, { uid, challenge }) {
  if (!config.jwtSecret) throw new Error('JWT_SECRET is missing');
  return jwt.sign(
    { purpose: PASSKEY_CHALLENGE_PURPOSE, uid, challenge },
    config.jwtSecret,
    {
      algorithm: 'HS256',
      expiresIn: '5m',
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
    }
  );
}

function verifyPasskeyChallenge(config, token, uid) {
  if (!config.jwtSecret) throw new Error('JWT_SECRET is missing');
  const decoded = jwt.verify(token, config.jwtSecret, {
    issuer: config.jwtIssuer,
    audience: config.jwtAudience,
  });
  if (
    decoded?.purpose !== PASSKEY_CHALLENGE_PURPOSE
    || decoded?.uid !== uid
    || typeof decoded?.challenge !== 'string'
  ) {
    throw new Error('Invalid passkey challenge');
  }
  return decoded.challenge;
}

function signDeleteProof(config, { uid, method, proofId }) {
  if (!config.jwtSecret) throw new Error('JWT_SECRET is missing');
  return jwt.sign(
    { purpose: DELETE_PROOF_PURPOSE, method, uid, proofId },
    config.jwtSecret,
    {
      algorithm: 'HS256',
      expiresIn: '5m',
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
    }
  );
}

async function createDeleteProof({ fbAdmin, db, config, uid, method }) {
  const proofId = randomUUID();
  const nowMs = Date.now();
  const expiresAtMs = nowMs + RECENT_AUTH_MAX_AGE_MS;
  await db
    .collection('users')
    .doc(uid)
    .collection(DELETE_PROOF_COLLECTION)
    .doc(proofId)
    .set({
      uid,
      method,
      used: false,
      createdAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
      createdAtMs: nowMs,
      expiresAt: fbAdmin.firestore.Timestamp.fromMillis(expiresAtMs),
      expiresAtMs,
    });

  return signDeleteProof(config, { uid, method, proofId });
}

async function verifyGoogleProof({ fbAdmin, uid, idToken }) {
  if (!idToken || typeof idToken !== 'string') throw new Error('Google verification is missing');
  const decoded = await fbAdmin.auth().verifyIdToken(idToken, true);
  if (decoded?.uid !== uid) throw new Error('Google verification does not match this account');
  if (decoded?.firebase?.sign_in_provider !== 'google.com') {
    throw new Error('Please verify with Google again.');
  }
  const authTimeMs = Number(decoded.auth_time || 0) * 1000;
  if (!authTimeMs || Date.now() - authTimeMs > RECENT_AUTH_MAX_AGE_MS) {
    throw new Error('Google verification expired. Please verify again.');
  }
  return true;
}

async function consumeDeleteProof({ fbAdmin, db, config, uid, method, verificationToken }) {
  if (!verificationToken || typeof verificationToken !== 'string') {
    throw new Error('Verification is missing');
  }
  const decoded = jwt.verify(verificationToken, config.jwtSecret, {
    issuer: config.jwtIssuer,
    audience: config.jwtAudience,
  });
  if (
    decoded?.purpose !== DELETE_PROOF_PURPOSE
    || decoded?.method !== method
    || decoded?.uid !== uid
    || typeof decoded?.proofId !== 'string'
  ) {
    throw new Error('Verification does not match this account');
  }
  const issuedAtMs = Number(decoded.iat || 0) * 1000;
  if (!issuedAtMs || Date.now() - issuedAtMs > RECENT_AUTH_MAX_AGE_MS) {
    throw new Error('Verification expired. Please verify again.');
  }

  const proofRef = db
    .collection('users')
    .doc(uid)
    .collection(DELETE_PROOF_COLLECTION)
    .doc(decoded.proofId);

  await db.runTransaction(async (transaction) => {
    const proofSnapshot = await transaction.get(proofRef);
    if (!proofSnapshot.exists) throw new Error('Verification expired. Please verify again.');
    const proof = proofSnapshot.data() || {};
    if (proof.uid !== uid || proof.method !== method) {
      throw new Error('Verification does not match this account');
    }
    if (proof.used) throw new Error('Verification was already used. Please verify again.');
    if (Number(proof.expiresAtMs || 0) <= Date.now()) {
      throw new Error('Verification expired. Please verify again.');
    }
    transaction.set(proofRef, {
      used: true,
      usedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
      usedAtMs: Date.now(),
    }, { merge: true });
  });

  return decoded;
}

function normalizeDeletionFeedback(value = {}) {
  const reason = String(value?.reason || '').trim();
  if (!DELETION_FEEDBACK_REASONS.has(reason)) {
    throw new Error('Choose why you are deleting your account');
  }

  const details = String(value?.details || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);

  if (reason === 'other' && details.length < 3) {
    throw new Error('Please write your reason before deleting your account');
  }

  return {
    reason,
    reasonLabel: DELETION_FEEDBACK_REASONS.get(reason),
    details,
  };
}

async function saveDeletedAccountFeedback({ fbAdmin, db, uid, user, feedback }) {
  const now = new Date();
  const name = typeof user?.name === 'string' && user.name.trim()
    ? user.name.trim()
    : [user?.firstName, user?.middleName, user?.lastName].filter(Boolean).join(' ').trim();

  await db.collection(DELETED_ACCOUNT_FEEDBACK_COLLECTION).doc().set({
    uid,
    name: name || '',
    reason: feedback.reason,
    reasonLabel: feedback.reasonLabel,
    details: feedback.details,
    submittedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
    submittedAtIso: now.toISOString(),
  });
}

async function deleteDocumentTree(db, ref, knownSubcollections = []) {
  const collectionMap = new Map();
  knownSubcollections.forEach((collectionName) => {
    collectionMap.set(collectionName, ref.collection(collectionName));
  });
  if (typeof ref.listCollections === 'function') {
    const discoveredCollections = await ref.listCollections();
    discoveredCollections.forEach((collectionRef) => {
      collectionMap.set(collectionRef.id, collectionRef);
    });
  }

  await Promise.all(Array.from(collectionMap.values()).map(async (collectionRef) => {
    const snapshot = await collectionRef.get();
    await Promise.all(snapshot.docs.map((doc) => deleteDocumentTree(db, doc.ref)));
  }));
  await ref.delete();
}

async function deletePhotoShareLinksForUser(db, uid) {
  let hasMore = true;
  while (hasMore) {
    const snapshot = await db
      .collection(PHOTO_SHARE_LINKS_COLLECTION)
      .where('ownerUid', '==', uid)
      .limit(200)
      .get();

    if (snapshot.empty) {
      hasMore = false;
      continue;
    }

    const batch = db.batch();
    snapshot.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });
    await batch.commit();
  }
}

async function deleteUserData({ config, uid, deletionFeedback }) {
  const fbAdmin = getFirebaseAdmin(config.firebaseServiceAccountPath);
  const auth = fbAdmin.auth();
  const db = fbAdmin.firestore();
  const userRef = db.collection('users').doc(uid);
  const userSnapshot = await userRef.get();
  const user = userSnapshot.exists ? userSnapshot.data() || {} : {};
  const profilePhotoPublicId = user?.profilePhoto?.publicId || '';
  const [supabaseContactPhotoPublicIds, firestoreContactPhotoPublicIds] = await Promise.all([
    readSupabaseContactPhotoPublicIds(uid),
    readFirestoreContactPhotoPublicIds(userRef),
  ]);

  await saveDeletedAccountFeedback({
    fbAdmin,
    db,
    uid,
    user,
    feedback: deletionFeedback,
  });

  await deleteCloudinaryAssetsForUser({
    config,
    uid,
    publicIds: [
      profilePhotoPublicId,
      ...supabaseContactPhotoPublicIds,
      ...firestoreContactPhotoPublicIds,
    ],
  });
  await deleteSupabaseUserData(uid);

  const loginActivityRef = db.collection(LOGIN_ACTIVITY_COLLECTION).doc(uid);
  const deleteOperations = [
    deleteDocumentTree(db, userRef),
    deleteDocumentTree(db, db.collection('passkey').doc(uid)),
    deleteDocumentTree(db, loginActivityRef, [
      SESSION_ACTIVE_COLLECTION,
      SESSION_EXPIRED_COLLECTION,
    ]),
    deletePhotoShareLinksForUser(db, uid),
  ];

  await Promise.all(deleteOperations);

  try {
    await auth.deleteUser(uid);
  } catch (error) {
    if (error?.code !== 'auth/user-not-found') throw error;
  }
}

export default function createDeleteAccountRouter({
  config,
  requireSession,
  clearSessionCookie,
  sensitiveActionLimiter,
}) {
  const router = express.Router();
  const limiter = typeof sensitiveActionLimiter === 'function' ? sensitiveActionLimiter : (_req, _res, next) => next();
  const expectedOrigin = getOrigins(config.frontendOrigin);
  const fallbackRpID = getRpID(getOrigins(config.frontendOrigin)[0] || '');

  router.post('/auth/delete-account/google/verify', requireSession, limiter, async (req, res) => {
    try {
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });

      const fbAdmin = getFirebaseAdmin(config.firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      await verifyGoogleProof({ fbAdmin, uid, idToken: req.body?.idToken });
      const verificationToken = await createDeleteProof({
        fbAdmin,
        db,
        config,
        uid,
        method: 'google',
      });
      return res.json({ ok: true, verificationToken });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error?.message || 'Could not verify Google' });
    }
  });

  router.post('/auth/delete-account/passkey/options', requireSession, limiter, async (req, res) => {
    try {
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });

      const fbAdmin = getFirebaseAdmin(config.firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const snapshot = await db.collection('passkey').doc(uid).get();
      const data = snapshot.exists ? snapshot.data() || {} : {};
      const passkeys = Array.isArray(data.passkeys) ? data.passkeys : [];
      if (!passkeys.length) {
        return res.status(400).json({ ok: false, error: 'No passkey is saved on this account' });
      }

      const options = await generateAuthenticationOptions({
        rpID: getRequestRpID(req.headers.origin || '', config.frontendOrigin || fallbackRpID),
        timeout: 60000,
        userVerification: 'required',
        allowCredentials: passkeys.map((passkey) => ({
          id: passkey.id,
          transports: Array.isArray(passkey.transports) ? passkey.transports : [],
        })),
      });
      const challengeId = signPasskeyChallenge(config, { uid, challenge: options.challenge });
      return res.json({ ok: true, challengeId, options });
    } catch (error) {
      const msg = sanitizeErrorMessage(error?.message) || 'Could not start passkey verification';
      return res.status(400).json({ ok: false, error: msg });
    }
  });

  router.post('/auth/delete-account/passkey/verify', requireSession, limiter, async (req, res) => {
    try {
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });
      const { challengeId, response } = req.body || {};
      const credentialId = response?.id;
      if (!challengeId || !credentialId) {
        return res.status(400).json({ ok: false, error: 'Missing passkey response' });
      }

      let expectedChallenge = '';
      try {
        expectedChallenge = verifyPasskeyChallenge(config, challengeId, uid);
      } catch {
        return res.status(400).json({ ok: false, error: 'Passkey verification expired. Please try again.' });
      }

      const fbAdmin = getFirebaseAdmin(config.firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const passkeyRef = db.collection('passkey').doc(uid);
      const snapshot = await passkeyRef.get();
      const passkeyData = snapshot.exists ? snapshot.data() || {} : {};
      const passkeys = Array.isArray(passkeyData.passkeys) ? passkeyData.passkeys : [];
      const storedCredential = passkeys.find((passkey) => passkey.id === credentialId);
      if (!storedCredential) {
        return res.status(401).json({ ok: false, error: 'Passkey does not belong to this account' });
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
        return res.status(401).json({ ok: false, error: 'Passkey could not be verified' });
      }

      const nowIso = new Date().toISOString();
      const nextPasskeys = passkeys.map((passkey) => (
        passkey.id === credentialId
          ? {
            ...passkey,
            counter: verification.authenticationInfo.newCounter,
            lastUsedAt: nowIso,
            deviceType: verification.authenticationInfo.credentialDeviceType || passkey.deviceType || '',
            backedUp: Boolean(verification.authenticationInfo.credentialBackedUp),
          }
          : passkey
      ));
      await passkeyRef.set({
        passkeys: nextPasskeys,
        updatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      const verificationToken = await createDeleteProof({
        fbAdmin,
        db,
        config,
        uid,
        method: 'passkey',
      });

      return res.json({
        ok: true,
        verificationToken,
      });
    } catch (error) {
      const msg = sanitizeErrorMessage(error?.message) || 'Could not verify passkey';
      return res.status(400).json({ ok: false, error: msg });
    }
  });

  router.post('/auth/delete-account', requireSession, limiter, async (req, res) => {
    try {
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });
      const confirmation = String(req.body?.confirmation || '').trim();
      if (confirmation !== DELETE_CONFIRMATION_PHRASE) {
        return res.status(400).json({ ok: false, error: `Type ${DELETE_CONFIRMATION_PHRASE} to continue` });
      }

      const method = String(req.body?.method || '').trim();
      const deletionFeedback = normalizeDeletionFeedback(req.body?.deletionFeedback || {});
      const fbAdmin = getFirebaseAdmin(config.firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      if (!['google', 'passkey'].includes(method)) {
        return res.status(400).json({ ok: false, error: 'Choose Google or Passkey verification' });
      }

      await consumeDeleteProof({
        fbAdmin,
        db,
        config,
        uid,
        method,
        verificationToken: req.body?.verificationToken,
      });
      await deleteUserData({ config, uid, deletionFeedback });
      if (typeof clearSessionCookie === 'function') clearSessionCookie(req, res);
      return res.json({ ok: true, deleted: true });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error?.message || 'Could not delete account' });
    }
  });

  return router;
}
