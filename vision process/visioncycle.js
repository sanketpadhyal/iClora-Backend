import { v2 as cloudinary } from 'cloudinary';
import { getFirebaseAdmin } from '../firebase.js';

const PRIVATE_UPLOAD_TYPE = 'authenticated';
const DEFAULT_INTERVAL_MS = 30 * 1000;
const DEFAULT_TIMEOUT_MS = 20 * 1000;
const DEFAULT_USER_SCAN_LIMIT = 100;
const DEFAULT_VISION_API_URL = '';

function cleanText(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function cleanVisionTags(value = []) {
  const rawTags = Array.isArray(value) ? value : String(value || '').split(/\s+/);
  return Array.from(new Set(rawTags
    .map((tag) => cleanText(tag).toLowerCase().replace(/[^a-z0-9-]/g, ''))
    .filter(Boolean)));
}

function cleanVisionLabel(value = '') {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim();
}

function signedCloudinaryUrl(publicId, resourceType = 'image') {
  if (!publicId) return '';
  return cloudinary.url(publicId, {
    secure: true,
    sign_url: true,
    type: PRIVATE_UPLOAD_TYPE,
    resource_type: resourceType || 'image',
    transformation: [
      {
        width: 1024,
        height: 1024,
        crop: 'limit',
        quality: 'auto',
        fetch_format: 'jpg',
      },
    ],
  });
}

function toSearchText(photo = {}, visionLabel = '', visionCaption = '', visionTags = []) {
  return [
    photo.title,
    photo.originalFilename,
    visionLabel,
    visionCaption,
    ...visionTags,
  ].map((value) => cleanText(value).toLowerCase()).filter(Boolean).join(' ');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function createVisionError(message, { status = 0, code = '', url = '' } = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.url = url;
  return error;
}

async function captionPhoto({ photo, visionApiUrl, timeoutMs }) {
  const imageUrl = signedCloudinaryUrl(photo.publicId, photo.resourceType);
  if (!imageUrl) throw new Error('Photo has no Cloudinary public id');

  const imageResponse = await fetchWithTimeout(imageUrl, {}, timeoutMs);
  if (!imageResponse.ok) {
    throw new Error(`Could not fetch photo from Cloudinary (${imageResponse.status})`);
  }

  const imageBlob = await imageResponse.blob();
  const formData = new FormData();
  formData.append('image', imageBlob, `${photo.id || 'photo'}.jpg`);

  const captionResponse = await fetchWithTimeout(`${visionApiUrl}/api/caption`, {
    method: 'POST',
    body: formData,
  }, timeoutMs);
  const json = await captionResponse.json().catch(() => ({}));
  if (!captionResponse.ok) {
    throw createVisionError(
      json?.error || `Vision backend failed (${captionResponse.status})`,
      { status: captionResponse.status, url: visionApiUrl }
    );
  }

  const visionCaption = cleanText(json?.caption).toLowerCase();
  const visionTags = cleanVisionTags(visionCaption);
  // visionLabel is the full caption statement, not just 3 words
  const visionLabel = visionCaption || visionTags.join(' ');
  if (!visionTags.length && !visionCaption) {
    throw new Error('Vision backend returned an empty caption');
  }

  return {
    visionLabel,
    visionTags,
    visionCaption,
    visionModel: cleanText(json?.model, 'Florence-2 base'),
    visionCycleSource: 'florence',
  };
}

function cleanPositiveInteger(value, fallback) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return fallback;
  return Math.max(1, Math.floor(amount));
}

async function findQueuedPhotoSnapshot({ db, userScanLimit }) {
  const usersSnapshot = await db.collection('users')
    .limit(userScanLimit)
    .get();

  for (const userSnapshot of usersSnapshot.docs) {
    const photoSnapshot = await userSnapshot.ref.collection('photos')
      .where('cycle', '==', 'no')
      .limit(1)
      .get();

    if (!photoSnapshot.empty) return photoSnapshot.docs[0];
  }

  return null;
}

async function leaseNextPhoto({ db, fbAdmin, userScanLimit }) {
  const candidate = await findQueuedPhotoSnapshot({ db, userScanLimit });
  if (!candidate) return null;

  const leased = await db.runTransaction(async (transaction) => {
    const freshSnap = await transaction.get(candidate.ref);
    if (!freshSnap.exists) return null;
    const fresh = freshSnap.data() || {};
    if (fresh.cycle !== 'no' || fresh.type !== 'photo' || fresh.deleted === true) return null;

    transaction.set(candidate.ref, {
      cycle: 'processing',
      visionCycleStatus: 'processing',
      visionCycleStartedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
      visionCycleUpdatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return {
      id: candidate.id,
      ref: candidate.ref,
      data: fresh,
    };
  });

  return leased;
}

export function startVisionCycle({
  firebaseServiceAccountPath,
  config = {},
  intervalMs = Number(process.env.VISION_CYCLE_INTERVAL_MS || DEFAULT_INTERVAL_MS),
  timeoutMs = Number(process.env.VISION_CYCLE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  userScanLimit = Number(process.env.VISION_CYCLE_USER_SCAN_LIMIT || DEFAULT_USER_SCAN_LIMIT),
} = {}) {
  if (process.env.VISION_CYCLE_ENABLED === 'false') {
    return { stop() {} };
  }

  if (!config.cloudinaryCloudName || !config.cloudinaryApiKey || !config.cloudinaryApiSecret) {
    console.warn('[visioncycle] Cloudinary is not configured; vision cycle disabled.');
    return { stop() {} };
  }

  const cleanVisionApiUrl = DEFAULT_VISION_API_URL;

  const cleanIntervalMs = Number.isFinite(intervalMs) && intervalMs >= 5000 ? intervalMs : DEFAULT_INTERVAL_MS;
  const cleanTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs >= 5000 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const cleanUserScanLimit = cleanPositiveInteger(userScanLimit, DEFAULT_USER_SCAN_LIMIT);
  let running = false;
  let stopped = false;
  let currentLease = null;

  cloudinary.config({
    cloud_name: config.cloudinaryCloudName,
    api_key: config.cloudinaryApiKey,
    api_secret: config.cloudinaryApiSecret,
  });

  const runOnce = async () => {
    if (running || stopped) return;
    running = true;

    try {
      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const leased = await leaseNextPhoto({ db, fbAdmin, userScanLimit: cleanUserScanLimit });
      if (!leased) return;
      currentLease = leased;

      const metadata = await captionPhoto({
        photo: { id: leased.id, ...leased.data },
        visionApiUrl: cleanVisionApiUrl,
        timeoutMs: cleanTimeoutMs,
      });
      const searchText = toSearchText(leased.data, metadata.visionLabel, metadata.visionCaption, metadata.visionTags);

      await leased.ref.set({
        ...metadata,
        searchText,
        cycle: 'yes',
        visionCycleStatus: 'complete',
        visionCycleError: '',
        visionCycleUpdatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
        updatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    } catch (error) {
      console.error('[visioncycle] cycle failed:', error);
      try {
        const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
        if (currentLease?.ref) {
          await currentLease.ref.set({
            cycle: 'no',
            visionCycleStatus: 'failed',
            visionCycleError: cleanText(error?.message, 'Vision cycle failed'),
            visionCycleUpdatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        }
      } catch (updateError) {
        console.error('[visioncycle] failed to release photo:', updateError);
      }
    } finally {
      currentLease = null;
      running = false;
    }
  };

  runOnce();
  const timer = setInterval(runOnce, cleanIntervalMs);
  timer.unref?.();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
