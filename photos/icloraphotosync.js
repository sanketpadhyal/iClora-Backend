import os from 'os';

const WEB_MAX_PHOTOS_PER_UPLOAD_BATCH = 3;
const WEB_UPLOAD_BATCH_WINDOW_MS = 60 * 1000;
const TRACKER_CLEANUP_MS = 10 * 60 * 1000;
const MOBILE_MIN_GAP_MS = 4_500;
const MOBILE_MAX_WAIT_MS = 45_000;
const MOBILE_COMPLETE_COOLDOWN_MS = 900;
const DEFAULT_PHOTO_BYTES = 4 * 1024 * 1024;
const MAX_ESTIMATE_MS = 45_000;
const MIN_ESTIMATE_MS = 4_000;
const MAX_TRACKED_ITEMS = 5_000;

const webUploadBatchTracker = new Map();
const mobileUploadTracker = new Map();
const uploadTicketTracker = new Map();
const uploadDurations = [];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function cleanText(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function cleanNumber(value, fallback = 0) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : fallback;
}

function cleanPhotoId(value = '') {
  return cleanText(value).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 120);
}

function getUploadBytes(req, fallback = DEFAULT_PHOTO_BYTES) {
  const source = {
    ...(req?.query || {}),
    ...(req?.body || {}),
  };
  return cleanNumber(source.bytes || source.size || source.fileSize || source.file_size, fallback);
}

function headerText(req, name) {
  return cleanText(typeof req?.get === 'function' ? req.get(name) : req?.headers?.[name.toLowerCase()]);
}

function clientHints(req) {
  const body = req?.body || {};
  const query = req?.query || {};
  return [
    headerText(req, 'x-iclora-client'),
    headerText(req, 'x-iclora-platform'),
    headerText(req, 'x-iclora-upload-client'),
    headerText(req, 'x-client-platform'),
    headerText(req, 'user-agent'),
    cleanText(body.client),
    cleanText(body.platform),
    cleanText(body.source),
    cleanText(body.app),
    cleanText(query.client),
    cleanText(query.platform),
    cleanText(query.source),
    cleanText(query.app),
  ].filter(Boolean).join(' ').toLowerCase();
}

function isMobileUploadRequest(req) {
  const hints = clientHints(req);
  return /\b(android|iclora-android|react-native|reactnative|okhttp|dalvik|mobile)\b/i.test(hints);
}

function cleanupTrackers(now = Date.now()) {
  for (const [key, record] of webUploadBatchTracker.entries()) {
    if (now - Number(record.lastSeenAt || record.startedAt || 0) > TRACKER_CLEANUP_MS) {
      webUploadBatchTracker.delete(key);
    }
  }

  for (const [key, record] of mobileUploadTracker.entries()) {
    if (now - Number(record.lastSeenAt || 0) > TRACKER_CLEANUP_MS) {
      mobileUploadTracker.delete(key);
    }
  }

  for (const [key, record] of uploadTicketTracker.entries()) {
    if (now - Number(record.issuedAt || 0) > TRACKER_CLEANUP_MS) {
      uploadTicketTracker.delete(key);
    }
  }

  if (webUploadBatchTracker.size > MAX_TRACKED_ITEMS) webUploadBatchTracker.clear();
  if (mobileUploadTracker.size > MAX_TRACKED_ITEMS) mobileUploadTracker.clear();
  if (uploadTicketTracker.size > MAX_TRACKED_ITEMS) uploadTicketTracker.clear();
}

function getServerLoadSnapshot() {
  const cpuCount = Math.max(1, os.cpus()?.length || 1);
  const loadOne = cleanNumber(os.loadavg?.()[0], 0);
  const loadRatio = loadOne / cpuCount;
  const memory = process.memoryUsage();
  const heapRatio = memory.heapTotal > 0 ? memory.heapUsed / memory.heapTotal : 0;
  const memoryPressure = heapRatio >= 0.94 ? 0.75 : heapRatio >= 0.88 ? 0.55 : heapRatio * 0.35;
  const activeMobileUploads = Array.from(mobileUploadTracker.values()).filter((record) => {
    return Number(record.nextAvailableAt || 0) > Date.now();
  }).length;
  const queuePressure = clamp(activeMobileUploads / 12, 0, 1.5);
  const pressure = Math.max(loadRatio, memoryPressure, queuePressure);
  const level = pressure >= 1 ? 'high' : pressure >= 0.65 ? 'busy' : 'ready';

  return {
    level,
    cpuCount,
    loadOne: Number(loadOne.toFixed(2)),
    loadRatio: Number(loadRatio.toFixed(2)),
    heapUsedMb: Number((memory.heapUsed / 1024 / 1024).toFixed(1)),
    heapTotalMb: Number((memory.heapTotal / 1024 / 1024).toFixed(1)),
    activeMobileUploads,
  };
}

function averageObservedUploadMs() {
  if (!uploadDurations.length) return 0;
  const total = uploadDurations.reduce((sum, value) => sum + value, 0);
  return Math.round(total / uploadDurations.length);
}

function estimatePhotoUploadMs(req, { load = getServerLoadSnapshot() } = {}) {
  const bytes = getUploadBytes(req);
  const megabytes = clamp(bytes / 1024 / 1024, 1, 30);
  const networkEstimate = 2_800 + megabytes * 950;
  const observed = averageObservedUploadMs();
  const baseline = observed > 0 ? observed * 0.55 + networkEstimate * 0.45 : networkEstimate;
  const loadMultiplier = load.level === 'high' ? 1.55 : load.level === 'busy' ? 1.25 : 1;
  return Math.round(clamp(baseline * loadMultiplier, MIN_ESTIMATE_MS, MAX_ESTIMATE_MS));
}

function getMobileWaitMs(uid, now = Date.now()) {
  const record = mobileUploadTracker.get(uid);
  return Math.max(0, Number(record?.nextAvailableAt || 0) - now);
}

function buildPacingHealth(req, options = {}) {
  const now = options.now || Date.now();
  const uid = cleanText(req?.session?.uid);
  const mobile = options.mobile ?? isMobileUploadRequest(req);
  const load = getServerLoadSnapshot();
  const estimatedMsPerPhoto = estimatePhotoUploadMs(req, { load });
  const retryAfterMs = uid && mobile ? getMobileWaitMs(uid, now) : 0;

  return {
    ok: true,
    serverTime: new Date(now).toISOString(),
    mode: mobile ? 'mobile-one-by-one' : 'web-batch',
    status: retryAfterMs > 0 || load.level === 'high' ? 'busy' : 'ready',
    estimatedMsPerPhoto,
    estimatedSecondsPerPhoto: Math.ceil(estimatedMsPerPhoto / 1000),
    retryAfterMs,
    retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
    activeMobileUploads: load.activeMobileUploads,
    load,
    limits: {
      mobileOneByOne: true,
      mobileMinGapMs: MOBILE_MIN_GAP_MS,
      mobileMaxWaitMs: MOBILE_MAX_WAIT_MS,
      webBatchLimit: WEB_MAX_PHOTOS_PER_UPLOAD_BATCH,
      webBatchWindowMs: WEB_UPLOAD_BATCH_WINDOW_MS,
    },
  };
}

function enforceWebUploadBatchLimit(req, now = Date.now()) {
  const uid = cleanText(req?.session?.uid);
  if (!uid) return { ok: false, status: 401, error: 'Missing session' };

  const rawBatchId = cleanText(req?.body?.uploadBatchId);
  const uploadBatchId = rawBatchId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || `legacy-${Math.floor(now / WEB_UPLOAD_BATCH_WINDOW_MS)}`;
  const trackerKey = `${uid}:${uploadBatchId}`;
  const record = webUploadBatchTracker.get(trackerKey);
  if (!record || now - record.startedAt > WEB_UPLOAD_BATCH_WINDOW_MS) {
    webUploadBatchTracker.set(trackerKey, { startedAt: now, count: 1, lastSeenAt: now });
    return { ok: true };
  }

  record.lastSeenAt = now;
  if (record.count >= WEB_MAX_PHOTOS_PER_UPLOAD_BATCH) {
    return {
      ok: false,
      status: 429,
      retryAfterMs: Math.max(1_000, WEB_UPLOAD_BATCH_WINDOW_MS - (now - record.startedAt)),
      error: `Upload limit reached. You can upload ${WEB_MAX_PHOTOS_PER_UPLOAD_BATCH} items at a time.`,
    };
  }

  record.count += 1;
  return { ok: true };
}

export function getPhotoUploadHealth(req, options = {}) {
  cleanupTrackers();
  return buildPacingHealth(req, options);
}

export function enforcePhotoUploadPacing(req, options = {}) {
  const now = Date.now();
  cleanupTrackers(now);

  const uid = cleanText(req?.session?.uid);
  if (!uid) return { ok: false, status: 401, error: 'Missing session' };

  const mobile = options.mobile ?? isMobileUploadRequest(req);
  if (!mobile) {
    const webCheck = enforceWebUploadBatchLimit(req, now);
    return {
      ...webCheck,
      mobile: false,
      uploadHealth: buildPacingHealth(req, { now, mobile: false }),
    };
  }

  const uploadHealth = buildPacingHealth(req, { now, mobile: true });
  const waitMs = getMobileWaitMs(uid, now);
  if (waitMs > 0) {
    return {
      ok: false,
      mobile: true,
      status: 429,
      retryAfterMs: waitMs,
      retryAfterSeconds: Math.ceil(waitMs / 1000),
      error: 'Please wait before starting the next photo upload.',
      uploadHealth: {
        ...uploadHealth,
        retryAfterMs: waitMs,
        retryAfterSeconds: Math.ceil(waitMs / 1000),
        status: 'busy',
      },
    };
  }

  const reservationMs = clamp(uploadHealth.estimatedMsPerPhoto, MOBILE_MIN_GAP_MS, MOBILE_MAX_WAIT_MS);
  const nextAvailableAt = now + reservationMs;
  mobileUploadTracker.set(uid, {
    lastSeenAt: now,
    nextAvailableAt,
  });

  const photoId = cleanPhotoId(options.photoId || req?.body?.photoId);
  if (photoId) {
    uploadTicketTracker.set(`${uid}:${photoId}`, {
      issuedAt: now,
      bytes: getUploadBytes(req),
      mobile: true,
    });
  }

  return {
    ok: true,
    mobile: true,
    retryAfterMs: 0,
    uploadHealth: {
      ...uploadHealth,
      retryAfterMs: 0,
      retryAfterSeconds: 0,
      status: 'ready',
    },
    uploadPacing: {
      mode: 'mobile-one-by-one',
      oneByOne: true,
      issuedAt: new Date(now).toISOString(),
      nextAvailableAt: new Date(nextAvailableAt).toISOString(),
      estimatedMsPerPhoto: uploadHealth.estimatedMsPerPhoto,
      estimatedSecondsPerPhoto: uploadHealth.estimatedSecondsPerPhoto,
    },
  };
}

export function recordPhotoUploadCompletion(req, details = {}) {
  const now = Date.now();
  cleanupTrackers(now);

  const uid = cleanText(req?.session?.uid);
  const photoId = cleanPhotoId(details.photoId || req?.body?.photoId);
  if (!uid || !photoId) return null;

  const key = `${uid}:${photoId}`;
  const ticket = uploadTicketTracker.get(key);
  if (!ticket) return null;

  const durationMs = clamp(now - Number(ticket.issuedAt || now), 1_000, 120_000);
  uploadDurations.push(durationMs);
  while (uploadDurations.length > 40) uploadDurations.shift();
  uploadTicketTracker.delete(key);

  if (ticket.mobile) {
    const record = mobileUploadTracker.get(uid);
    if (record) {
      record.lastSeenAt = now;
      record.nextAvailableAt = Math.min(Number(record.nextAvailableAt || now), now + MOBILE_COMPLETE_COOLDOWN_MS);
    }
  }

  return {
    ok: true,
    durationMs,
    durationSeconds: Math.ceil(durationMs / 1000),
    averageMsPerPhoto: averageObservedUploadMs(),
  };
}
