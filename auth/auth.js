import { getFirebaseAdmin } from '../firebase.js';

export async function handleFirebaseIdToken({ idToken, config, signJwt, loginOnly = false }) {
  if (!idToken) throw new Error('Missing idToken');

  const fbAdmin = getFirebaseAdmin(config.firebaseServiceAccountPath);
  const decoded = await fbAdmin.auth().verifyIdToken(idToken);
  if (!decoded?.uid) throw new Error('Invalid Firebase token');

  const uid = decoded.uid;
  const email = decoded.email || '';
  const providerName = decoded.name || '';

  const auth = fbAdmin.auth();
  const db = fbAdmin.firestore();

  try {
    await auth.getUser(uid);
  } catch {
    if (loginOnly) {
      const error = new Error('this acc doesnt exist');
      error.status = 404;
      throw error;
    }
    await auth.createUser({
      uid,
      email: email || undefined,
      displayName: providerName || undefined,
      emailVerified: Boolean(decoded.email_verified),
    });
  }

  const userRef = db.collection('users').doc(uid);
  const userSnapshot = await userRef.get();
  const existingUser = userSnapshot.exists ? userSnapshot.data() || {} : {};
  if (loginOnly && !userSnapshot.exists) {
    const error = new Error('this acc doesnt exist');
    error.status = 404;
    throw error;
  }
  const isNewUser = !userSnapshot.exists;
  const name = typeof existingUser?.name === 'string' && existingUser.name ? existingUser.name : providerName;
  const profilePhotoUrl = existingUser?.profilePhoto?.url || existingUser?.picture || '';
  const needsProfilePhoto = !profilePhotoUrl;
  const plan = typeof existingUser?.plan === 'string' && existingUser.plan ? existingUser.plan : 'basic';
  const storage = typeof existingUser?.storage === 'number' && Number.isFinite(existingUser.storage) ? existingUser.storage : 1024;
  const now = fbAdmin.firestore.FieldValue.serverTimestamp();

  const userJson = {
    uid,
    email,
    name,
    provider: decoded.firebase?.sign_in_provider || 'firebase',
    emailVerified: Boolean(decoded.email_verified),
    lastLoginAt: now,
    lastLoginBy: decoded.firebase?.sign_in_provider || 'firebase',
    firebase: {
      signInProvider: decoded.firebase?.sign_in_provider || null,
    },
  };

  const userPayload = {
    ...userJson,
  };

  // Keep default subscription fields only for first-time users or legacy docs.
  if (typeof existingUser.storage === 'undefined') {
    userPayload.storage = 1024;
  }
  if (typeof existingUser.plan === 'undefined') {
    userPayload.plan = 'basic';
  }
  if (typeof existingUser.storageused !== 'undefined') {
    userPayload.storageused = fbAdmin.firestore.FieldValue.delete();
  }
  if (!userSnapshot.exists || typeof existingUser.createdAt === 'undefined') {
    userPayload.createdAt = fbAdmin.firestore.FieldValue.serverTimestamp();
  }

  await userRef.set(userPayload, { merge: true });

  const sessionJwt = signJwt({ uid, email });

  return {
    uid,
    email,
    name,
    provider: userJson.provider,
    sessionJwt,
    isNewUser,
    needsProfilePhoto,
    profilePhotoUrl,
    plan,
    storage,
    storageused: 0,
  };
}
