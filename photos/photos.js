import express from 'express';
import jwt from 'jsonwebtoken';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'crypto';
import { Readable } from 'stream';
import { v2 as cloudinary } from 'cloudinary';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { LOGIN_ACTIVITY_COLLECTION, SESSION_ACTIVE_COLLECTION, getDeviceName } from '../auth/authactivity.js';
import { getFirebaseAdmin } from '../firebase.js';
import {
  enforcePhotoUploadPacing,
  getPhotoUploadHealth,
  recordPhotoUploadCompletion,
} from './icloraphotosync.js';
import { assertStorageCapacity } from '../storage/quota.js';

const MAX_BATCH_DELETE = 100;
const DEFAULT_PHOTOS_PAGE_SIZE = 60;
const MAX_PHOTOS_PAGE_SIZE = 120;
const PRIVATE_UPLOAD_TYPE = 'authenticated';
const HIDDEN_AUTH_KEY_BYTES = 32;
const HIDDEN_AUTH_TRUST_MS = 10 * 60 * 1000;
const HIDDEN_PASSKEY_CHALLENGE_PURPOSE = 'hidden-photos-passkey-auth';
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
]);
const ALLOWED_IMAGE_FORMATS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif']);
const BROWSER_UNSAFE_IMAGE_FORMATS = new Set(['heic', 'heif']);

function ensureCloudinaryConfigured(config) {
  if (!config.cloudinaryCloudName || !config.cloudinaryApiKey || !config.cloudinaryApiSecret) {
    throw new Error('Cloudinary is not configured');
  }

  cloudinary.config({
    cloud_name: config.cloudinaryCloudName,
    api_key: config.cloudinaryApiKey,
    api_secret: config.cloudinaryApiSecret,
  });
}

function cleanText(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function cleanHiddenPasscode(value = '') {
  return cleanText(value).replace(/\D/g, '').slice(0, 12);
}

function hashHiddenPasscode(passcode, salt) {
  return scryptSync(passcode, salt, HIDDEN_AUTH_KEY_BYTES).toString('hex');
}

function verifyHiddenPasscode(passcode, auth = {}) {
  if (!auth?.salt || !auth?.hash) return false;
  const expected = Buffer.from(String(auth.hash), 'hex');
  const actual = Buffer.from(hashHiddenPasscode(passcode, String(auth.salt)), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function fromBase64Url(value) {
  return Buffer.from(String(value || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function toVerifyCredential(stored) {
  return {
    id: stored.id,
    publicKey: new Uint8Array(fromBase64Url(stored.publicKey)),
    counter: Number.isFinite(Number(stored.counter)) ? Number(stored.counter) : 0,
    transports: Array.isArray(stored.transports) ? stored.transports : [],
  };
}

function getOrigins(frontendOrigin = '') {
  return String(frontendOrigin || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function getRpID(origin = '') {
  if (!origin) return 'localhost';
  try {
    return new URL(origin).hostname;
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

function trustHiddenPhotosSession(req) {
  if (!req?.session) return;
  req.session.hiddenPhotosVerifiedUntil = Date.now() + HIDDEN_AUTH_TRUST_MS;
}

function issueHiddenPhotosAccessToken(req, config = {}) {
  const uid = typeof req?.session?.uid === 'string' ? req.session.uid.trim() : '';
  if (!uid || !config.jwtSecret) return '';
  return jwt.sign(
    { uid, purpose: 'hidden-photos' },
    config.jwtSecret,
    {
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
      expiresIn: Math.max(60, Math.floor(HIDDEN_AUTH_TRUST_MS / 1000)),
    },
  );
}

function hiddenPhotosSessionVerified(req, config = {}) {
  if (Number(req?.session?.hiddenPhotosVerifiedUntil || 0) > Date.now()) return true;
  const uid = typeof req?.session?.uid === 'string' ? req.session.uid.trim() : '';
  const token = cleanText(req.get?.('x-iclora-hidden-photos-token'));
  if (!uid || !token || !config.jwtSecret) return false;
  try {
    const decoded = jwt.verify(token, config.jwtSecret, {
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
    });
    return decoded?.uid === uid && decoded?.purpose === 'hidden-photos';
  } catch {
    return false;
  }
}

function signHiddenPasskeyChallenge(config = {}, { uid, challenge }) {
  if (!config.jwtSecret) throw new Error('JWT_SECRET is missing');
  return jwt.sign(
    { purpose: HIDDEN_PASSKEY_CHALLENGE_PURPOSE, uid, challenge },
    config.jwtSecret,
    {
      algorithm: 'HS256',
      expiresIn: '5m',
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
    },
  );
}

function verifyHiddenPasskeyChallenge(config = {}, token, uid) {
  if (!config.jwtSecret) throw new Error('JWT_SECRET is missing');
  const decoded = jwt.verify(token, config.jwtSecret, {
    issuer: config.jwtIssuer,
    audience: config.jwtAudience,
  });
  if (decoded?.purpose !== HIDDEN_PASSKEY_CHALLENGE_PURPOSE || decoded?.uid !== uid || typeof decoded?.challenge !== 'string') {
    throw new Error('Invalid passkey challenge');
  }
  return decoded.challenge;
}

async function verifyGoogleHiddenProof({ fbAdmin, uid, idToken }) {
  const decoded = await fbAdmin.auth().verifyIdToken(cleanText(idToken), true);
  if (!decoded?.uid || decoded.uid !== uid) {
    throw new Error('That Google account does not match this iClora account.');
  }
  const providerIds = Array.isArray(decoded.firebase?.identities?.['google.com'])
    ? decoded.firebase.identities['google.com']
    : [];
  const signInProvider = cleanText(decoded.firebase?.sign_in_provider);
  if (signInProvider !== 'google.com' && !providerIds.length) {
    throw new Error('Please verify with Google.');
  }
  return decoded;
}

function publicPhotosMeta(data = {}) {
  const {
    hiddenAuth,
    hiddenPhotosAuth,
    ...meta
  } = data || {};
  return {
    ...meta,
    hiddenAuthEnabled: Boolean(hiddenAuth?.enabled || hiddenPhotosAuth?.enabled),
  };
}

function cleanVisionTags(value = []) {
  const rawTags = Array.isArray(value) ? value : String(value || '').split(/\s+/);
  return Array.from(new Set(rawTags
    .map((tag) => cleanText(tag).toLowerCase().replace(/[^a-z0-9-]/g, ''))
    .filter(Boolean)))
    .slice(0, 3);
}

function cleanVisionLabel(value = '') {
  return cleanVisionTags(value).join(' ');
}

function safeCloudinarySegment(value = '') {
  return String(value || 'user').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96) || 'user';
}

function toIso(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value?.toDate === 'function') return value.toDate().toISOString();
  return '';
}

function toMbFromBytes(bytes) {
  const amount = Number(bytes);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Number((amount / (1024 * 1024)).toFixed(4));
}

function normalizeFileFormat(value = '') {
  return cleanText(value).replace(/^\./, '').toLowerCase();
}

function formatStorageLimit(mb) {
  const amount = Number(mb);
  if (!Number.isFinite(amount) || amount <= 0) return '0 MB';
  if (amount >= 1024) return `${Number((amount / 1024).toFixed(1))} GB`;
  return `${Number(amount.toFixed(1))} MB`;
}

function imageFormatFromFilename(filename = '') {
  const match = cleanText(filename).toLowerCase().match(/\.([a-z0-9]+)$/);
  const format = match ? match[1] : '';
  return format === 'jpg' ? 'jpeg' : format;
}

function validateImageUpload({ filename = '', mimeType = '', resourceType = '', format = '' } = {}) {
  const normalizedMime = cleanText(mimeType).toLowerCase();
  const normalizedResourceType = cleanText(resourceType, 'image').toLowerCase();
  const normalizedFormat = normalizeFileFormat(format || imageFormatFromFilename(filename));

  if (normalizedResourceType && normalizedResourceType !== 'image') {
    return { ok: false, error: 'Videos are not supported in iClora Photos. Upload images only.' };
  }
  if (normalizedMime && !ALLOWED_IMAGE_MIME_TYPES.has(normalizedMime)) {
    return { ok: false, error: 'Unsupported image format. Use JPEG, PNG, WebP, GIF, HEIC, or HEIF.' };
  }
  if (normalizedFormat && !ALLOWED_IMAGE_FORMATS.has(normalizedFormat)) {
    return { ok: false, error: 'Unsupported image format. Use JPEG, PNG, WebP, GIF, HEIC, or HEIF.' };
  }

  return { ok: true };
}

function needsBrowserSafeImageDelivery(data = {}) {
  const format = normalizeFileFormat(data.format || imageFormatFromFilename(data.originalFilename || data.original_filename || data.title));
  const mimeType = cleanText(data.mimeType || data.mime_type).toLowerCase();
  return BROWSER_UNSAFE_IMAGE_FORMATS.has(format)
    || mimeType === 'image/heic'
    || mimeType === 'image/heif';
}

function profilePhotoStorageMb(user = {}) {
  const bytes = Number(user?.profilePhoto?.bytes);
  return Number.isFinite(bytes) && bytes > 0 ? toMbFromBytes(bytes) : 0;
}

function userStorageLimitMb(user = {}) {
  const storage = Number(user.storage);
  return Number.isFinite(storage) && storage > 0 ? storage : 1024;
}

async function readAccountStorageUsedMb(userRef, user = {}) {
  const db = userRef.firestore;
  const [photosMeta, notesMeta, contactsMeta, recentlyDeletedSnapshot, legacyDeletedSnapshot] = await Promise.all([
    userRef.collection('photos').doc('meta').get(),
    userRef.collection('notes').doc('meta').get(),
    userRef.collection('contacts').doc('meta').get(),
    db.collection('recentlyDeleted').doc(userRef.id).collection('photos').get(),
    userRef.collection('photos').where('deleted', '==', true).get(),
  ]);
  const deletedPhotosStorage = [...recentlyDeletedSnapshot.docs, ...legacyDeletedSnapshot.docs]
    .reduce((total, doc) => total + photoStorageUsed(doc.data() || {}), 0);
  const appStorage = [photosMeta, notesMeta, contactsMeta].reduce((total, snap) => {
    const data = snap.exists ? snap.data() || {} : {};
    const storageUsed = Number(data.storageUsed);
    return total + (Number.isFinite(storageUsed) && storageUsed > 0 ? storageUsed : 0);
  }, deletedPhotosStorage);
  return Number((appStorage + profilePhotoStorageMb(user)).toFixed(4));
}

async function ensureStorageRoom({ userRef, user, incomingStorageMb, currentStorageMb = 0 }) {
  const storageLimit = userStorageLimitMb(user);
  const currentUsed = await readAccountStorageUsedMb(userRef, user);
  const nextUsed = Number((Math.max(0, currentUsed - currentStorageMb) + Math.max(0, incomingStorageMb)).toFixed(4));
  if (nextUsed > storageLimit) {
    return {
      ok: false,
      status: 413,
      error: `Storage limit reached. Your ${formatStorageLimit(storageLimit)} plan does not have enough space for this photo.`,
    };
  }
  return { ok: true, currentUsed, nextUsed, storageLimit };
}

function timestampToDate(value) {
  const iso = toIso(value);
  if (iso) {
    const parsed = new Date(iso);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

function formatPhotoDate(value) {
  const date = timestampToDate(value);
  const dateLabel = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
  const timeLabel = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
  return {
    shortDate: dateLabel,
    date: `${dateLabel} at ${timeLabel}`,
  };
}

function photoStorageUsed(data = {}) {
  const stored = Number(data.storageUsed);
  if (Number.isFinite(stored) && stored > 0) return stored;
  return toMbFromBytes(data.bytes);
}

function isPhotoStorageItem(data = {}) {
  return data.resourceType !== 'video' && data.type !== 'video';
}

function photoMetaDelta(data = {}, direction = 1) {
  if (!isPhotoStorageItem(data)) {
    return { storage: 0, photos: 0, videos: 0, items: 0 };
  }
  return {
    storage: Number((photoStorageUsed(data) * direction).toFixed(4)),
    photos: direction,
    videos: 0,
    items: direction,
  };
}

function addDelta(total = {}, delta = {}) {
  return {
    storage: Number((Number(total.storage || 0) + Number(delta.storage || 0)).toFixed(4)),
    photos: Number(total.photos || 0) + Number(delta.photos || 0),
    videos: Number(total.videos || 0) + Number(delta.videos || 0),
    items: Number(total.items || 0) + Number(delta.items || 0),
  };
}

function negateDelta(delta = {}) {
  return {
    storage: Number((-Number(delta.storage || 0)).toFixed(4)),
    photos: -Number(delta.photos || 0),
    videos: -Number(delta.videos || 0),
    items: -Number(delta.items || 0),
  };
}

function writePhotosMetaDelta({ fbAdmin, writer, metaRef, active = {}, deleted = {} }) {
  const activeStorage = Number((Number(active.storage || 0)).toFixed(4));
  const deletedStorage = Number((Number(deleted.storage || 0)).toFixed(4));
  const totalStorage = Number((activeStorage + deletedStorage).toFixed(4));
  const patch = {
    type: 'meta',
    status: 'activate',
    active: true,
    updatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
  };

  if (activeStorage) patch.storageUsed = fbAdmin.firestore.FieldValue.increment(activeStorage);
  if (deletedStorage) patch.deletedStorageUsed = fbAdmin.firestore.FieldValue.increment(deletedStorage);
  if (totalStorage) patch.totalStorageUsed = fbAdmin.firestore.FieldValue.increment(totalStorage);
  if (active.photos) patch.photosCount = fbAdmin.firestore.FieldValue.increment(active.photos);
  if (active.videos) patch.videosCount = fbAdmin.firestore.FieldValue.increment(active.videos);
  if (active.items) patch.itemsCount = fbAdmin.firestore.FieldValue.increment(active.items);

  writer.set(metaRef, patch, { merge: true });
}

function signedCloudinaryUrl(publicId, options = {}) {
  if (!publicId) return '';
  return cloudinary.url(publicId, {
    secure: true,
    sign_url: true,
    type: PRIVATE_UPLOAD_TYPE,
    resource_type: options.resourceType || 'image',
    transformation: options.transformation,
  });
}

function formatPhoto(id, data = {}) {
  const resourceType = cleanText(data.resourceType, 'image');
  const publicId = cleanText(data.publicId);
  const staticSrc = cleanText(data.staticSrc);
  const useBrowserSafeImage = resourceType === 'image' && needsBrowserSafeImageDelivery(data);
  const originalUrl = signedCloudinaryUrl(publicId, { resourceType }) || staticSrc;
  const browserSafeUrl = useBrowserSafeImage
    ? signedCloudinaryUrl(publicId, {
        resourceType,
        transformation: [
          {
            quality: 'auto',
            fetch_format: 'jpg',
          },
        ],
      })
    : '';
  const thumbnailSrc = signedCloudinaryUrl(publicId, {
    resourceType,
    transformation: [
      {
        width: 520,
        height: 520,
        crop: 'fill',
        gravity: 'auto',
        quality: 'auto',
        fetch_format: useBrowserSafeImage ? 'jpg' : 'auto',
      },
    ],
  }) || browserSafeUrl || originalUrl;
  const uploadedAt = toIso(data.uploadedAt) || toIso(data.createdAt) || new Date().toISOString();
  const labels = formatPhotoDate(uploadedAt);
  const type = resourceType === 'video' ? 'video' : 'photo';
  const displayUrl = browserSafeUrl || originalUrl;

  return {
    id,
    type,
    title: cleanText(data.title, data.originalFilename || 'iClora Photo'),
    src: displayUrl,
    thumbnailSrc: thumbnailSrc || displayUrl,
    displaySrc: displayUrl,
    originalUrl,
    staticSrc,
    publicId,
    assetId: cleanText(data.assetId),
    bytes: Number(data.bytes || 0),
    storageUsed: photoStorageUsed(data),
    width: Number(data.width || 0),
    height: Number(data.height || 0),
    format: cleanText(data.format),
    mimeType: cleanText(data.mimeType),
    resourceType,
    favourite: Boolean(data.favourite),
    hidden: Boolean(data.hidden),
    deleted: Boolean(data.deleted),
    system: Boolean(data.system),
    locked: Boolean(data.locked),
    date: data.date || labels.date,
    shortDate: data.shortDate || labels.shortDate,
    location: cleanText(data.location),
    duration: cleanText(data.duration),
    originalFilename: cleanText(data.originalFilename),
    syncedBy: cleanText(data.syncedBy),
    syncedByEmail: cleanText(data.syncedByEmail),
    syncedByProvider: cleanText(data.syncedByProvider),
    syncedDeviceName: cleanText(data.syncedDeviceName || data.deviceName),
    syncedDeviceType: cleanText(data.syncedDeviceType || data.deviceType),
    syncedAt: toIso(data.syncedAt),
    uploadedAt,
    createdAt: toIso(data.createdAt),
    updatedAt: toIso(data.updatedAt),
    cycle: cleanText(data.cycle, data.visionLabel || data.visionCaption ? 'yes' : ''),
    visionCycleStatus: cleanText(data.visionCycleStatus),
    visionCycleError: cleanText(data.visionCycleError),
    visionCycleSource: cleanText(data.visionCycleSource),
    visionLabel: cleanText(data.visionLabel),
    visionTags: Array.isArray(data.visionTags) ? data.visionTags.map((tag) => cleanText(tag)).filter(Boolean).slice(0, 8) : [],
    visionCaption: cleanText(data.visionCaption),
    searchText: cleanText(data.searchText),
  };
}

async function getPhotoSyncContext({ db, uid, user = {}, req }) {
  const sessionId = cleanText(req?.session?.sessionId);
  let session = {};
  if (sessionId) {
    try {
      const sessionSnap = await db
        .collection(LOGIN_ACTIVITY_COLLECTION)
        .doc(uid)
        .collection(SESSION_ACTIVE_COLLECTION)
        .doc(sessionId)
        .get();
      session = sessionSnap.exists ? sessionSnap.data() || {} : {};
    } catch {
      session = {};
    }
  }

  const syncedByName = cleanText([
    user.firstName,
    user.middleName,
    user.lastName,
  ].map((part) => cleanText(part)).filter(Boolean).join(' '));
  const syncedByEmail = cleanText(req?.session?.email || user.email);
  const userAgent = cleanText(req?.get?.('user-agent'));

  return {
    syncedBy: syncedByName || cleanText(user.name) || syncedByEmail,
    syncedByEmail,
    syncedByProvider: cleanText(session.provider || user.lastLoginBy || user.provider),
    syncedDeviceName: cleanText(session.deviceName) || getDeviceName(userAgent),
    syncedDeviceType: cleanText(session.deviceType),
    syncedAt: new Date().toISOString(),
  };
}

function formatShareLink(id, data = {}) {
  const photos = Array.isArray(data.photos) ? data.photos : [];
  const photoCount = photos.length || Number(data.photoCount || 0) || (data.photoId ? 1 : 0);
  return {
    id,
    token: cleanText(data.token, id),
    photoId: cleanText(data.photoId),
    photoTitle: cleanText(data.photoTitle, 'iClora Photo'),
    photoCount,
    urlPath: `/share/photos/${cleanText(data.token, id)}`,
    durationHours: Number(data.durationHours || 24),
    createdAt: toIso(data.createdAt),
    expiresAt: toIso(data.expiresAt),
  };
}

function formatSharedPhoto(token, photo = {}, index = 0) {
  return {
    id: cleanText(photo.photoId || photo.id),
    title: cleanText(photo.photoTitle || photo.title, 'iClora Photo'),
    src: `/photos/share/${token}/media/${index}`,
    resourceType: cleanText(photo.resourceType, 'image'),
    mimeType: cleanText(photo.mimeType),
    width: Number(photo.width || 0),
    height: Number(photo.height || 0),
  };
}

function legacySharedPhoto(link = {}) {
  return {
    photoId: cleanText(link.photoId),
    photoTitle: cleanText(link.photoTitle, 'iClora Photo'),
    publicId: cleanText(link.publicId),
    staticSrc: cleanText(link.staticSrc),
    resourceType: cleanText(link.resourceType, 'image'),
    mimeType: cleanText(link.mimeType),
    width: Number(link.width || 0),
    height: Number(link.height || 0),
  };
}

function sharedPhotoMediaUrl(photo = {}) {
  const resourceType = cleanText(photo.resourceType, 'image');
  const publicId = cleanText(photo.publicId);
  if (resourceType === 'image' && publicId && needsBrowserSafeImageDelivery(photo)) {
    return signedCloudinaryUrl(publicId, {
      resourceType,
      transformation: [
        {
          quality: 'auto',
          fetch_format: 'jpg',
        },
      ],
    });
  }
  return cleanText(photo.staticSrc) || signedCloudinaryUrl(publicId, { resourceType });
}

function shareLinkMediaUrl(link = {}) {
  return sharedPhotoMediaUrl({
    publicId: link.publicId,
    staticSrc: link.staticSrc,
    resourceType: link.resourceType || 'image',
    mimeType: link.mimeType,
    format: link.format,
    originalFilename: link.originalFilename || link.photoTitle,
    title: link.photoTitle,
  });
}

function sortPhotosDesc(a, b) {
  const bTime = Date.parse(b.uploadedAt || b.createdAt || b.updatedAt || '') || 0;
  const aTime = Date.parse(a.uploadedAt || a.createdAt || a.updatedAt || '') || 0;
  return bTime - aTime;
}

function parsePhotoPageLimit(value) {
  const limit = Number(value || 0);
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.min(MAX_PHOTOS_PAGE_SIZE, Math.max(1, Math.floor(limit)));
}

function encodePhotoPageCursor(doc) {
  if (!doc?.id) return '';
  const data = doc.data?.() || {};
  const uploadedAt = toIso(data.uploadedAt) || '';
  if (!uploadedAt) return '';
  return Buffer.from(JSON.stringify({ uploadedAt, id: doc.id })).toString('base64url');
}

function decodePhotoPageCursor(value = '') {
  const raw = cleanText(value);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    const uploadedAt = cleanText(parsed?.uploadedAt);
    const id = cleanText(parsed?.id);
    return uploadedAt && id ? { uploadedAt, id } : null;
  } catch {
    return null;
  }
}

function photoVisibleForPage(data = {}, { hidden = false } = {}) {
  if (data.type !== 'photo' || data.resourceType === 'video') return false;
  if (data.deleted === true) return false;
  return hidden ? data.hidden === true : data.hidden !== true;
}

async function readPhotoPage({ fbAdmin, userRef, limit = DEFAULT_PHOTOS_PAGE_SIZE, cursor = '', hidden = false }) {
  const pageLimit = Math.min(MAX_PHOTOS_PAGE_SIZE, Math.max(1, Number(limit || DEFAULT_PHOTOS_PAGE_SIZE)));
  const fieldPath = fbAdmin.firestore.FieldPath;
  const decodedCursor = decodePhotoPageCursor(cursor);
  const photos = [];
  let hasMore = false;
  let nextCursor = '';
  let lastScannedDoc = null;
  let query = userRef
    .collection('photos')
    .orderBy('uploadedAt', 'desc')
    .orderBy(fieldPath.documentId(), 'desc');

  if (decodedCursor) {
    query = query.startAfter(decodedCursor.uploadedAt, decodedCursor.id);
  }

  const fetchLimit = Math.min(MAX_PHOTOS_PAGE_SIZE, Math.max(pageLimit + 1, pageLimit * 2));
  let safety = 0;

  while (photos.length <= pageLimit && safety < 4) {
    const snapshot = await query.limit(fetchLimit).get();
    if (snapshot.empty) break;
    safety += 1;
    snapshot.docs.forEach((doc) => {
      lastScannedDoc = doc;
      const data = doc.data() || {};
      if (doc.id === 'meta' || data.type === 'meta') return;
      if (!photoVisibleForPage(data, { hidden })) return;
      if (photos.length <= pageLimit) photos.push(formatPhoto(doc.id, data));
    });
    if (snapshot.size < fetchLimit) break;
    query = userRef
      .collection('photos')
      .orderBy('uploadedAt', 'desc')
      .orderBy(fieldPath.documentId(), 'desc')
      .startAfter(lastScannedDoc.get('uploadedAt'), lastScannedDoc.id);
  }

  if (photos.length > pageLimit) {
    photos.pop();
    const lastReturned = photos[photos.length - 1];
    nextCursor = lastReturned
      ? Buffer.from(JSON.stringify({ uploadedAt: lastReturned.uploadedAt, id: lastReturned.id })).toString('base64url')
      : encodePhotoPageCursor(lastScannedDoc);
    hasMore = true;
  } else if (lastScannedDoc) {
    const probe = await userRef
      .collection('photos')
      .orderBy('uploadedAt', 'desc')
      .orderBy(fieldPath.documentId(), 'desc')
      .startAfter(lastScannedDoc.get('uploadedAt'), lastScannedDoc.id)
      .limit(1)
      .get();
    hasMore = !probe.empty;
    nextCursor = hasMore ? encodePhotoPageCursor(lastScannedDoc) : '';
  }

  return {
    photos,
    pagination: {
      limit: pageLimit,
      hasMore,
      nextCursor,
    },
  };
}

async function ensurePhotosCloud({ fbAdmin, userRef }) {
  const metaRef = userRef.collection('photos').doc('meta');
  const metaSnap = await metaRef.get();
  const meta = metaSnap.exists ? metaSnap.data() || {} : {};
  if (meta.active !== true) return false;
  await metaRef.set({
    type: 'meta',
    status: 'activate',
    active: true,
    updatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  return true;
}

async function refreshPhotosMeta({ fbAdmin, userRef }) {
  const photosRef = userRef.collection('photos');
  const db = userRef.firestore;
  const [snapshot, recentlyDeletedSnapshot] = await Promise.all([
    photosRef.get(),
    db.collection('recentlyDeleted').doc(userRef.id).collection('photos').get(),
  ]);
  let photosCount = 0;
  let videosCount = 0;
  let storageUsed = 0;
  let deletedStorageUsed = 0;

  snapshot.forEach((doc) => {
    const data = doc.data() || {};
    if (doc.id === 'meta' || data.type === 'meta' || data.type === 'photo-message') return;
    if (data.deleted) {
      deletedStorageUsed += photoStorageUsed(data);
      return;
    }
    if (data.resourceType === 'video' || data.type === 'video') return;
    photosCount += 1;
    storageUsed += photoStorageUsed(data);
  });

  recentlyDeletedSnapshot.forEach((doc) => {
    deletedStorageUsed += photoStorageUsed(doc.data() || {});
  });

  const roundedStorageUsed = Number(storageUsed.toFixed(4));
  const roundedDeletedStorageUsed = Number(deletedStorageUsed.toFixed(4));
  await photosRef.doc('meta').set({
    type: 'meta',
    status: 'activate',
    active: true,
    storageUsed: roundedStorageUsed,
    deletedStorageUsed: roundedDeletedStorageUsed,
    totalStorageUsed: Number((roundedStorageUsed + roundedDeletedStorageUsed).toFixed(4)),
    photosCount,
    videosCount,
    itemsCount: photosCount + videosCount,
    updatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  return {
    storageUsed: roundedStorageUsed,
    deletedStorageUsed: roundedDeletedStorageUsed,
    totalStorageUsed: Number((roundedStorageUsed + roundedDeletedStorageUsed).toFixed(4)),
    photosCount,
    videosCount,
    itemsCount: photosCount + videosCount,
  };
}

async function readPhotosMetaForResponse({ fbAdmin, userRef }) {
  const metaRef = userRef.collection('photos').doc('meta');
  const metaSnap = await metaRef.get();
  const meta = metaSnap.exists ? metaSnap.data() || {} : {};
  if (meta.active === true && (
    typeof meta.deletedStorageUsed !== 'number'
    || typeof meta.totalStorageUsed !== 'number'
  )) {
    const refreshed = await refreshPhotosMeta({ fbAdmin, userRef });
    return {
      ...meta,
      ...refreshed,
    };
  }
  return meta;
}

async function destroyCloudinaryAsset(publicId, resourceType = 'image') {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, {
      resource_type: resourceType || 'image',
      type: PRIVATE_UPLOAD_TYPE,
      invalidate: true,
    });
  } catch {
  }
}

async function getActiveShareLink({ firebaseServiceAccountPath, token }) {
  const cleanToken = cleanText(token).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!cleanToken) {
    const error = new Error('Invalid iClora Link');
    error.status = 400;
    throw error;
  }

  const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
  const db = fbAdmin.firestore();
  const linkRef = db.collection('photoShareLinks').doc(cleanToken);
  const linkSnap = await linkRef.get();
  if (!linkSnap.exists) {
    const error = new Error('iClora Link not found');
    error.status = 404;
    throw error;
  }

  const link = linkSnap.data() || {};
  const expiresAt = timestampToDate(link.expiresAt);
  if (link.revoked === true || expiresAt.getTime() <= Date.now()) {
    const error = new Error('This iClora Link has expired');
    error.status = 410;
    throw error;
  }

  return { token: cleanToken, link };
}

export default function createPhotosRouter({
  firebaseServiceAccountPath,
  requireSession,
  config,
  useSupabaseForNotes = false,
  useSupabaseForContacts = false,
}) {
  const router = express.Router();
  const expectedOrigin = getOrigins(config.frontendOrigin);
  const fallbackRpID = getRpID(expectedOrigin[0] || '');

  router.get('/photos/share/:token', async (req, res) => {
    try {
      ensureCloudinaryConfigured(config);
      const { token, link } = await getActiveShareLink({ firebaseServiceAccountPath, token: req.params?.token });

      const linkPhotos = Array.isArray(link.photos) && link.photos.length ? link.photos : [legacySharedPhoto(link)];
      const readyPhotos = linkPhotos.filter((photo) => cleanText(photo.staticSrc) || cleanText(photo.publicId));
      if (!readyPhotos.length) return res.status(404).json({ ok: false, error: 'Shared photo is unavailable' });
      const photos = readyPhotos.map((photo, index) => formatSharedPhoto(token, photo, index));

      return res.json({
        ok: true,
        photo: photos[0],
        photos,
        link: formatShareLink(token, link),
      });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to open iClora Link' });
    }
  });

  router.get('/photos/share/:token/media/:photoIndex', async (req, res) => {
    try {
      ensureCloudinaryConfigured(config);
      const { link } = await getActiveShareLink({ firebaseServiceAccountPath, token: req.params?.token });
      const linkPhotos = Array.isArray(link.photos) && link.photos.length ? link.photos : [legacySharedPhoto(link)];
      const index = Math.max(0, Number.parseInt(req.params?.photoIndex, 10) || 0);
      const photo = linkPhotos[index];
      if (!photo) return res.status(404).json({ ok: false, error: 'Shared photo is unavailable' });
      const mediaUrl = sharedPhotoMediaUrl(photo);
      if (!mediaUrl) return res.status(404).json({ ok: false, error: 'Shared photo is unavailable' });

      const upstream = await fetch(mediaUrl, {
        headers: req.headers.range ? { Range: req.headers.range } : undefined,
      });
      if (!upstream.ok && upstream.status !== 206) {
        return res.status(upstream.status || 502).json({ ok: false, error: 'Shared photo is unavailable' });
      }

      res.status(upstream.status);
      ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach((header) => {
        const value = upstream.headers.get(header);
        if (value) res.setHeader(header, value);
      });
      res.setHeader('Cache-Control', 'private, no-store, max-age=0');
      res.setHeader('X-Content-Type-Options', 'nosniff');

      if (!upstream.body) return res.end();
      return Readable.fromWeb(upstream.body).pipe(res);
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to open shared photo' });
    }
  });

  router.get('/photos/share/:token/media', async (req, res) => {
    try {
      ensureCloudinaryConfigured(config);
      const { link } = await getActiveShareLink({ firebaseServiceAccountPath, token: req.params?.token });
      const mediaUrl = shareLinkMediaUrl(link);
      if (!mediaUrl) return res.status(404).json({ ok: false, error: 'Shared photo is unavailable' });

      const upstream = await fetch(mediaUrl, {
        headers: req.headers.range ? { Range: req.headers.range } : undefined,
      });
      if (!upstream.ok && upstream.status !== 206) {
        return res.status(upstream.status || 502).json({ ok: false, error: 'Shared photo is unavailable' });
      }

      res.status(upstream.status);
      ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach((header) => {
        const value = upstream.headers.get(header);
        if (value) res.setHeader(header, value);
      });
      res.setHeader('Cache-Control', 'private, no-store, max-age=0');
      res.setHeader('X-Content-Type-Options', 'nosniff');

      if (!upstream.body) return res.end();
      return Readable.fromWeb(upstream.body).pipe(res);
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to open shared photo' });
    }
  });

  if (typeof requireSession === 'function') router.use(requireSession);

  router.get('/photos/upload-health', async (req, res) => {
    try {
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });
      return res.json(getPhotoUploadHealth(req));
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to read upload health' });
    }
  });

  router.get('/photos', async (req, res) => {
    try {
      ensureCloudinaryConfigured(config);
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });

      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const userRef = db.collection('users').doc(uid);
      const active = await ensurePhotosCloud({ fbAdmin, userRef });
      if (!active) return res.status(403).json({ ok: false, needsSetup: true, error: 'Photos Cloud is not activated' });
      const responseMeta = await readPhotosMetaForResponse({ fbAdmin, userRef });

      const photos = [];
      let meta = {
        ...publicPhotosMeta(responseMeta),
        activatedOn: toIso(responseMeta.activatedOn),
        updatedAt: toIso(responseMeta.updatedAt),
      };
      const pageLimit = parsePhotoPageLimit(req.query?.limit);

      if (pageLimit) {
        const page = await readPhotoPage({
          fbAdmin,
          userRef,
          limit: pageLimit,
          cursor: req.query?.cursor,
        });
        return res.json({
          ok: true,
          photos: page.photos,
          meta,
          pagination: page.pagination,
        });
      }

      const snapshot = await userRef.collection('photos').get();
      snapshot.forEach((doc) => {
        const data = doc.data() || {};
        if (doc.id === 'meta' || data.type === 'meta') {
          return;
        }
        if (data.hidden === true || data.deleted === true) return;
        if (data.type === 'photo' && data.resourceType !== 'video') photos.push(formatPhoto(doc.id, data));
      });

      return res.json({
        ok: true,
        photos: photos.sort(sortPhotosDesc),
        meta,
      });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to load photos' });
    }
  });

  router.get('/photos/hidden', async (req, res) => {
    try {
      ensureCloudinaryConfigured(config);
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });
      if (!hiddenPhotosSessionVerified(req, config)) {
        return res.status(403).json({
          ok: false,
          needsHiddenAuth: true,
          error: 'Verify Hidden Photos to continue.',
        });
      }

      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const userRef = db.collection('users').doc(uid);
      const active = await ensurePhotosCloud({ fbAdmin, userRef });
      if (!active) return res.status(403).json({ ok: false, needsSetup: true, error: 'Photos Cloud is not activated' });
      const responseMeta = await readPhotosMetaForResponse({ fbAdmin, userRef });

      const photos = [];
      let meta = {
        ...publicPhotosMeta(responseMeta),
        activatedOn: toIso(responseMeta.activatedOn),
        updatedAt: toIso(responseMeta.updatedAt),
      };
      const pageLimit = parsePhotoPageLimit(req.query?.limit);

      if (pageLimit) {
        const page = await readPhotoPage({
          fbAdmin,
          userRef,
          limit: pageLimit,
          cursor: req.query?.cursor,
          hidden: true,
        });
        return res.json({
          ok: true,
          photos: page.photos,
          meta,
          pagination: page.pagination,
        });
      }

      const snapshot = await userRef.collection('photos').get();
      snapshot.forEach((doc) => {
        const data = doc.data() || {};
        if (doc.id === 'meta' || data.type === 'meta') {
          return;
        }
        if (data.hidden !== true || data.deleted === true) return;
        if (data.type === 'photo' && data.resourceType !== 'video') photos.push(formatPhoto(doc.id, data));
      });

      return res.json({
        ok: true,
        photos: photos.sort(sortPhotosDesc),
        meta,
      });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to load Hidden Photos' });
    }
  });

  router.get('/photos/hidden-auth', async (req, res) => {
    try {
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });

      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const userRef = db.collection('users').doc(uid);
      const active = await ensurePhotosCloud({ fbAdmin, userRef });
      if (!active) return res.status(403).json({ ok: false, needsSetup: true, error: 'Photos Cloud is not activated' });

      const metaSnap = await userRef.collection('photos').doc('meta').get();
      const meta = metaSnap.exists ? metaSnap.data() || {} : {};
      return res.json({
        ok: true,
        enabled: Boolean(meta.hiddenAuth?.enabled),
        verified: hiddenPhotosSessionVerified(req, config),
      });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to load Hidden Photos verification' });
    }
  });

  router.post('/photos/hidden-auth/setup', async (req, res) => {
    try {
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });
      const passcode = cleanHiddenPasscode(req.body?.passcode);
      if (passcode.length < 4) return res.status(400).json({ ok: false, error: 'Use at least 4 digits.' });

      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const userRef = db.collection('users').doc(uid);
      const active = await ensurePhotosCloud({ fbAdmin, userRef });
      if (!active) return res.status(403).json({ ok: false, needsSetup: true, error: 'Photos Cloud is not activated' });

      const metaRef = userRef.collection('photos').doc('meta');
      const metaSnap = await metaRef.get();
      const meta = metaSnap.exists ? metaSnap.data() || {} : {};
      if (meta.hiddenAuth?.enabled) return res.status(409).json({ ok: false, error: 'Hidden Photos verification is already set up.' });

      const salt = randomBytes(16).toString('hex');
      const hash = hashHiddenPasscode(passcode, salt);
      await metaRef.set({
        hiddenAuth: {
          enabled: true,
          salt,
          hash,
          algorithm: 'scrypt',
          createdAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
          updatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
        },
        updatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      trustHiddenPhotosSession(req);

      return res.json({ ok: true, enabled: true, verified: true, hiddenAccessToken: issueHiddenPhotosAccessToken(req, config) });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to set up Hidden Photos verification' });
    }
  });

  router.post('/photos/hidden-auth/verify', async (req, res) => {
    try {
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });
      const passcode = cleanHiddenPasscode(req.body?.passcode);
      if (passcode.length < 4) return res.status(400).json({ ok: false, error: 'Use at least 4 digits.' });

      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const userRef = db.collection('users').doc(uid);
      const active = await ensurePhotosCloud({ fbAdmin, userRef });
      if (!active) return res.status(403).json({ ok: false, needsSetup: true, error: 'Photos Cloud is not activated' });

      const metaSnap = await userRef.collection('photos').doc('meta').get();
      const meta = metaSnap.exists ? metaSnap.data() || {} : {};
      if (!meta.hiddenAuth?.enabled) return res.status(404).json({ ok: false, needsSetup: true, error: 'Hidden Photos verification is not set up.' });
      if (!verifyHiddenPasscode(passcode, meta.hiddenAuth)) return res.status(401).json({ ok: false, error: 'That passcode did not match.' });
      trustHiddenPhotosSession(req);

      return res.json({ ok: true, verified: true, hiddenAccessToken: issueHiddenPhotosAccessToken(req, config) });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to verify Hidden Photos' });
    }
  });

  router.post('/photos/hidden-auth/google/verify', async (req, res) => {
    try {
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });

      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const userRef = db.collection('users').doc(uid);
      const active = await ensurePhotosCloud({ fbAdmin, userRef });
      if (!active) return res.status(403).json({ ok: false, needsSetup: true, error: 'Photos Cloud is not activated' });

      await verifyGoogleHiddenProof({ fbAdmin, uid, idToken: req.body?.idToken });
      trustHiddenPhotosSession(req);
      return res.json({ ok: true, verified: true, hiddenAccessToken: issueHiddenPhotosAccessToken(req, config) });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error?.message || 'Could not verify Google' });
    }
  });

  router.post('/photos/hidden-auth/passkey/options', async (req, res) => {
    try {
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });

      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const snapshot = await db.collection('passkey').doc(uid).get();
      const data = snapshot.exists ? snapshot.data() || {} : {};
      const passkeys = Array.isArray(data.passkeys) ? data.passkeys : [];
      if (!passkeys.length) return res.status(400).json({ ok: false, error: 'No passkey is saved on this account' });

      const options = await generateAuthenticationOptions({
        rpID: getRequestRpID(req.headers.origin || '', config.frontendOrigin || fallbackRpID),
        timeout: 60000,
        userVerification: 'required',
        allowCredentials: passkeys.map((passkey) => ({
          id: passkey.id,
          transports: Array.isArray(passkey.transports) ? passkey.transports : [],
        })),
      });
      const challengeId = signHiddenPasskeyChallenge(config, { uid, challenge: options.challenge });
      return res.json({ ok: true, challengeId, options });
    } catch (error) {
      const msg = sanitizeErrorMessage(error?.message) || 'Could not start passkey verification';
      return res.status(400).json({ ok: false, error: msg });
    }
  });

  router.post('/photos/hidden-auth/passkey/verify', async (req, res) => {
    try {
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });
      const { challengeId, response } = req.body || {};
      const credentialId = response?.id;
      if (!challengeId || !credentialId) return res.status(400).json({ ok: false, error: 'Missing passkey response' });

      let expectedChallenge = '';
      try {
        expectedChallenge = verifyHiddenPasskeyChallenge(config, challengeId, uid);
      } catch {
        return res.status(400).json({ ok: false, error: 'Passkey verification expired. Please try again.' });
      }

      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const userRef = db.collection('users').doc(uid);
      const active = await ensurePhotosCloud({ fbAdmin, userRef });
      if (!active) return res.status(403).json({ ok: false, needsSetup: true, error: 'Photos Cloud is not activated' });

      const passkeyRef = db.collection('passkey').doc(uid);
      const snapshot = await passkeyRef.get();
      const passkeyData = snapshot.exists ? snapshot.data() || {} : {};
      const passkeys = Array.isArray(passkeyData.passkeys) ? passkeyData.passkeys : [];
      const storedCredential = passkeys.find((passkey) => passkey.id === credentialId);
      if (!storedCredential) return res.status(401).json({ ok: false, error: 'Passkey does not belong to this account' });

      const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin,
        expectedRPID: getRequestRpID(req.headers.origin || '', config.frontendOrigin || fallbackRpID),
        credential: toVerifyCredential(storedCredential),
        requireUserVerification: true,
      });
      if (!verification.verified) return res.status(401).json({ ok: false, error: 'Passkey could not be verified' });

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

      trustHiddenPhotosSession(req);
      return res.json({ ok: true, verified: true, hiddenAccessToken: issueHiddenPhotosAccessToken(req, config) });
    } catch (error) {
      const msg = sanitizeErrorMessage(error?.message) || 'Could not verify passkey';
      return res.status(400).json({ ok: false, error: msg });
    }
  });

  router.post('/photos/upload-signature', async (req, res) => {
    try {
      ensureCloudinaryConfigured(config);
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });
      const uploadCheck = validateImageUpload({
        filename: req.body?.filename,
        mimeType: req.body?.mimeType,
        resourceType: 'image',
      });
      if (!uploadCheck.ok) return res.status(400).json({ ok: false, error: uploadCheck.error });
      const requestedPhotoId = cleanText(req.body?.photoId).replace(/[^a-zA-Z0-9_-]/g, '-');
      const photoId = requestedPhotoId && requestedPhotoId.startsWith('photo-') ? requestedPhotoId : `photo-${randomUUID()}`;
      const pacingCheck = enforcePhotoUploadPacing(req, { photoId });
      if (!pacingCheck.ok) {
        if (pacingCheck.retryAfterSeconds) res.set('Retry-After', String(pacingCheck.retryAfterSeconds));
        return res.status(pacingCheck.status || 429).json({
          ok: false,
          error: pacingCheck.error,
          retryAfterMs: pacingCheck.retryAfterMs || 0,
          retryAfterSeconds: pacingCheck.retryAfterSeconds || 0,
          uploadHealth: pacingCheck.uploadHealth,
        });
      }

      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const userRef = db.collection('users').doc(uid);
      const active = await ensurePhotosCloud({ fbAdmin, userRef });
      if (!active) return res.status(403).json({ ok: false, needsSetup: true, error: 'Photos Cloud is not activated' });
      const userSnap = await userRef.get();
      const user = userSnap.exists ? userSnap.data() || {} : {};
      const incomingStorageMb = toMbFromBytes(req.body?.bytes || req.body?.size || 0);
      if (incomingStorageMb > 0) {
        await assertStorageCapacity({
          firebaseServiceAccountPath,
          uid,
          userRef,
          user,
          incomingStorageMb,
          useSupabaseForNotes,
          useSupabaseForContacts,
        });
      }

      const folder = `iclora/photos/${safeCloudinarySegment(uid)}`;
      const timestamp = Math.floor(Date.now() / 1000);
      const uploadParams = {
        folder,
        public_id: photoId,
        timestamp,
        type: PRIVATE_UPLOAD_TYPE,
      };
      const signature = cloudinary.utils.api_sign_request(uploadParams, config.cloudinaryApiSecret);

      return res.json({
        ok: true,
        photoId,
        cloudName: config.cloudinaryCloudName,
        apiKey: config.cloudinaryApiKey,
        uploadUrl: `https://api.cloudinary.com/v1_1/${config.cloudinaryCloudName}/image/upload`,
        params: {
          ...uploadParams,
          signature,
          api_key: config.cloudinaryApiKey,
        },
        uploadPacing: pacingCheck.uploadPacing || null,
        uploadHealth: pacingCheck.uploadHealth || null,
      });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to prepare upload' });
    }
  });

  router.post('/photos', async (req, res) => {
    try {
      ensureCloudinaryConfigured(config);
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });

      const body = req.body || {};
      const photoId = cleanText(body.photoId, `photo-${randomUUID()}`).replace(/[^a-zA-Z0-9_-]/g, '-');
      const publicId = cleanText(body.publicId || body.public_id);
      const folderPrefix = `iclora/photos/${safeCloudinarySegment(uid)}/`;
      if (!publicId || !publicId.startsWith(folderPrefix)) {
        return res.status(400).json({ ok: false, error: 'Invalid uploaded photo' });
      }

      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const userRef = db.collection('users').doc(uid);
      const active = await ensurePhotosCloud({ fbAdmin, userRef });
      if (!active) return res.status(403).json({ ok: false, needsSetup: true, error: 'Photos Cloud is not activated' });

      const uploadedAt = toIso(body.createdAt || body.created_at) || new Date().toISOString();
      const labels = formatPhotoDate(uploadedAt);
      const resourceType = cleanText(body.resourceType || body.resource_type, 'image');
      const bytes = Number(body.bytes || 0);
      const title = cleanText(body.title, cleanText(body.originalFilename || body.original_filename, 'iClora Photo'));
      const storageUsed = toMbFromBytes(bytes);
      const imageCheck = validateImageUpload({
        filename: body.originalFilename || body.original_filename || body.title,
        mimeType: body.mimeType,
        resourceType,
        format: body.format,
      });
      if (!imageCheck.ok) {
        await destroyCloudinaryAsset(publicId, resourceType);
        return res.status(400).json({ ok: false, error: imageCheck.error });
      }
      const photoRef = userRef.collection('photos').doc(photoId);
      const currentSnap = await photoRef.get();
      if (currentSnap.exists && currentSnap.data()?.publicId && currentSnap.data()?.publicId !== publicId) {
        return res.status(409).json({ ok: false, error: 'Photo already exists' });
      }
      const userSnap = await userRef.get();
      const user = userSnap.exists ? userSnap.data() || {} : {};
      const syncContext = await getPhotoSyncContext({ db, uid, user, req });
      const currentStorageMb = currentSnap.exists ? photoStorageUsed(currentSnap.data() || {}) : 0;
      try {
        await assertStorageCapacity({
          firebaseServiceAccountPath,
          uid,
          userRef,
          user,
          incomingStorageMb: storageUsed,
          replacingStorageMb: currentStorageMb,
          useSupabaseForNotes,
          useSupabaseForContacts,
        });
      } catch (error) {
        await destroyCloudinaryAsset(publicId, resourceType);
        return res.status(error?.status || 413).json({ ok: false, error: error?.message || 'Storage limit reached' });
      }

      const payload = {
        type: 'photo',
        title,
        publicId,
        assetId: cleanText(body.assetId || body.asset_id),
        resourceType: 'image',
        format: cleanText(body.format),
        mimeType: cleanText(body.mimeType),
        bytes,
        storageUsed,
        width: Number(body.width || 0),
        height: Number(body.height || 0),
        originalFilename: cleanText(body.originalFilename || body.original_filename),
        originalSecureUrl: cleanText(body.secureUrl || body.secure_url),
        ...syncContext,
        favourite: Boolean(currentSnap.data()?.favourite),
        hidden: Boolean(currentSnap.data()?.hidden),
        deleted: false,
        date: labels.date,
        shortDate: labels.shortDate,
        uploadedAt,
        cycle: 'no',
        visionCycleStatus: 'queued',
        visionCycleError: '',
        createdAt: currentSnap.exists ? currentSnap.data()?.createdAt || fbAdmin.firestore.FieldValue.serverTimestamp() : fbAdmin.firestore.FieldValue.serverTimestamp(),
        updatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
      };
      const visionTags = cleanVisionTags(body.visionTags || body.visionLabel || body.visionCaption);
      if (visionTags.length) {
        const visionLabel = cleanVisionLabel(body.visionLabel) || visionTags.join(' ');
        const visionCaption = cleanText(body.visionCaption, visionLabel).toLowerCase();
        payload.visionLabel = visionLabel;
        payload.visionTags = visionTags;
        payload.visionCaption = visionCaption;
        payload.visionModel = cleanText(body.visionModel, 'Florence-2 base');
        payload.searchText = [
          title,
          payload.originalFilename,
          visionLabel,
          visionCaption,
          ...visionTags,
        ].map((value) => cleanText(value).toLowerCase()).filter(Boolean).join(' ');
        payload.cycle = 'yes';
        payload.visionCycleStatus = 'complete';
      }

      await photoRef.set(payload, { merge: true });
      const uploadTiming = recordPhotoUploadCompletion(req, { photoId, bytes });
      const meta = await refreshPhotosMeta({ fbAdmin, userRef });
      const savedSnap = await photoRef.get();

      return res.json({
        ok: true,
        photo: formatPhoto(photoId, savedSnap.data() || payload),
        meta,
        uploadTiming,
      });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to save photo' });
    }
  });

  router.get('/photos/share-links', async (req, res) => {
    try {
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });

      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const snapshot = await db.collection('photoShareLinks')
        .where('ownerUid', '==', uid)
        .limit(40)
        .get();
      const links = [];
      snapshot.forEach((doc) => {
        const data = doc.data() || {};
        if (data.revoked === true) return;
        links.push(formatShareLink(doc.id, data));
      });
      links.sort((a, b) => (Date.parse(b.createdAt || '') || 0) - (Date.parse(a.createdAt || '') || 0));
      return res.json({ ok: true, links });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to load iClora Links' });
    }
  });

  router.post('/photos/share-links', async (req, res) => {
    try {
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });

      const photoIds = Array.isArray(req.body?.photoIds)
        ? req.body.photoIds.map((id) => cleanText(id)).filter(Boolean)
        : [cleanText(req.body?.photoId)].filter(Boolean);
      const durationHours = Math.max(1, Math.min(168, Number(req.body?.durationHours || 24)));
      const uniquePhotoIds = Array.from(new Set(photoIds)).filter((id) => id && id !== 'meta').slice(0, 25);
      if (!uniquePhotoIds.length) return res.status(400).json({ ok: false, error: 'Invalid photo' });

      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const userRef = db.collection('users').doc(uid);
      const active = await ensurePhotosCloud({ fbAdmin, userRef });
      if (!active) return res.status(403).json({ ok: false, needsSetup: true, error: 'Photos Cloud is not activated' });

      const sharedPhotos = [];
      for (const photoId of uniquePhotoIds) {
        const photoSnap = await userRef.collection('photos').doc(photoId).get();
        if (!photoSnap.exists) return res.status(404).json({ ok: false, error: 'Photo not found' });
        const photo = photoSnap.data() || {};
        if (photo.deleted === true) return res.status(400).json({ ok: false, error: 'Deleted photos cannot be shared' });

        const publicId = cleanText(photo.publicId);
        const staticSrc = cleanText(photo.staticSrc);
        if (!publicId && !staticSrc) return res.status(400).json({ ok: false, error: 'Photo is not ready to share yet' });
        sharedPhotos.push({
          photoId,
          photoTitle: cleanText(photo.title, photo.originalFilename || 'iClora Photo'),
          publicId,
          staticSrc,
          resourceType: cleanText(photo.resourceType, 'image'),
          mimeType: cleanText(photo.mimeType),
          format: cleanText(photo.format),
          originalFilename: cleanText(photo.originalFilename),
          width: Number(photo.width || 0),
          height: Number(photo.height || 0),
        });
      }

      const token = randomUUID().replace(/-/g, '');
      const now = new Date();
      const expiresAt = new Date(now.getTime() + durationHours * 60 * 60 * 1000);
      const firstPhoto = sharedPhotos[0] || {};
      const photoTitle = sharedPhotos.length === 1
        ? cleanText(firstPhoto.photoTitle, 'iClora Photo')
        : `${sharedPhotos.length} iClora Photos`;
      const payload = {
        token,
        ownerUid: uid,
        photoId: cleanText(firstPhoto.photoId),
        photoTitle,
        publicId: cleanText(firstPhoto.publicId),
        staticSrc: cleanText(firstPhoto.staticSrc),
        resourceType: cleanText(firstPhoto.resourceType, 'image'),
        mimeType: cleanText(firstPhoto.mimeType),
        format: cleanText(firstPhoto.format),
        originalFilename: cleanText(firstPhoto.originalFilename),
        width: Number(firstPhoto.width || 0),
        height: Number(firstPhoto.height || 0),
        photos: sharedPhotos,
        photoCount: sharedPhotos.length,
        durationHours,
        revoked: false,
        createdAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
        expiresAt,
      };

      await db.collection('photoShareLinks').doc(token).set(payload);
      return res.json({ ok: true, link: formatShareLink(token, { ...payload, createdAt: now }) });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to create iClora Link' });
    }
  });

  router.delete('/photos/share-links/:linkId', async (req, res) => {
    try {
      const { uid } = req.session || {};
      const linkId = cleanText(req.params?.linkId).replace(/[^a-zA-Z0-9_-]/g, '');
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });
      if (!linkId) return res.status(400).json({ ok: false, error: 'Invalid iClora Link' });

      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const linkRef = db.collection('photoShareLinks').doc(linkId);
      const linkSnap = await linkRef.get();
      if (!linkSnap.exists) return res.status(404).json({ ok: false, error: 'iClora Link not found' });
      if ((linkSnap.data() || {}).ownerUid !== uid) return res.status(403).json({ ok: false, error: 'Not allowed' });

      await linkRef.delete();
      return res.json({ ok: true, deletedId: linkId });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to delete iClora Link' });
    }
  });

  router.patch('/photos/:photoId', async (req, res) => {
    try {
      ensureCloudinaryConfigured(config);
      const { uid } = req.session || {};
      const { photoId } = req.params || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });
      if (!photoId || photoId === 'meta') return res.status(400).json({ ok: false, error: 'Invalid photo' });

      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const photoRef = db.collection('users').doc(uid).collection('photos').doc(photoId);
      const snap = await photoRef.get();
      if (!snap.exists) return res.status(404).json({ ok: false, error: 'Photo not found' });

      const patch = {
        updatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
      };
      if (typeof req.body?.deleted === 'boolean') {
        return res.status(400).json({ ok: false, error: 'Use the delete or restore endpoint to change photo deletion state' });
      }
      ['favourite', 'hidden'].forEach((key) => {
        if (typeof req.body?.[key] === 'boolean') patch[key] = req.body[key];
      });

      await photoRef.set(patch, { merge: true });
      const userRef = db.collection('users').doc(uid);
      const meta = publicPhotosMeta(await readPhotosMetaForResponse({ fbAdmin, userRef }));
      const updatedSnap = await photoRef.get();
      return res.json({ ok: true, photo: formatPhoto(photoId, updatedSnap.data() || {}), meta });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to update photo' });
    }
  });

  router.delete('/photos/:photoId', async (req, res) => {
    try {
      ensureCloudinaryConfigured(config);
      const { uid } = req.session || {};
      const { photoId } = req.params || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });
      if (!photoId || photoId === 'meta') return res.status(400).json({ ok: false, error: 'Invalid photo' });

      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const userRef = db.collection('users').doc(uid);
      const photoRef = userRef.collection('photos').doc(photoId);
      const deletedAt = new Date().toISOString();
      const trashRef = db.collection('recentlyDeleted').doc(uid).collection('photos').doc(photoId);

      await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(photoRef);
        if (!snap.exists) throw httpError('Photo not found', 404);
        const data = snap.data() || {};
        if (data.system === true || data.locked === true) {
          throw httpError('This iClora photo cannot be deleted', 403);
        }
        if (data.deleted === true) throw httpError('Photo is already deleted', 400);

        const delta = photoMetaDelta(data, 1);
        transaction.set(trashRef, {
          ...data,
          deletedAt,
          _original: { ...data },
        });
        transaction.delete(photoRef);
        writePhotosMetaDelta({
          fbAdmin,
          writer: transaction,
          metaRef: userRef.collection('photos').doc('meta'),
          active: negateDelta(delta),
          deleted: delta,
        });
      });

      const meta = publicPhotosMeta(await readPhotosMetaForResponse({ fbAdmin, userRef }));
      return res.json({ ok: true, deletedIds: [photoId], meta });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to delete photo' });
    }
  });

  router.post('/photos/delete', async (req, res) => {
    try {
      ensureCloudinaryConfigured(config);
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });

      const ids = Array.from(new Set(Array.isArray(req.body?.ids) ? req.body.ids : []))
        .map((id) => cleanText(id))
        .filter((id) => id && id !== 'meta')
        .slice(0, MAX_BATCH_DELETE);
      if (!ids.length) return res.status(400).json({ ok: false, error: 'No photos selected' });

      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const userRef = db.collection('users').doc(uid);
      const photosRef = userRef.collection('photos');
      const refs = ids.map((id) => photosRef.doc(id));
      const deletedAt = new Date().toISOString();

      const deletedIds = await db.runTransaction(async (transaction) => {
        const snaps = await Promise.all(refs.map((ref) => transaction.get(ref)));
        const movedIds = [];
        let activeDelta = {};
        let deletedDelta = {};

        snaps.forEach((snap) => {
          if (!snap.exists) return;
          const data = snap.data() || {};
          if (data.system === true || data.locked === true || data.deleted === true) return;
          const delta = photoMetaDelta(data, 1);
          activeDelta = addDelta(activeDelta, negateDelta(delta));
          deletedDelta = addDelta(deletedDelta, delta);
          const trashRef = db.collection('recentlyDeleted').doc(uid).collection('photos').doc(snap.id);
          transaction.set(trashRef, {
            ...data,
            deletedAt,
            _original: { ...data },
          });
          transaction.delete(snap.ref);
          movedIds.push(snap.id);
        });

        if (!movedIds.length) throw httpError('Photos not found', 404);
        writePhotosMetaDelta({
          fbAdmin,
          writer: transaction,
          metaRef: photosRef.doc('meta'),
          active: activeDelta,
          deleted: deletedDelta,
        });
        return movedIds;
      });

      const meta = publicPhotosMeta(await readPhotosMetaForResponse({ fbAdmin, userRef }));

      return res.json({ ok: true, deletedIds, meta });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to delete selected photos' });
    }
  });

  return router;
}
