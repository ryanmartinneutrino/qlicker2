import crypto from 'node:crypto';
import ActivityGrant from '../models/ActivityGrant.js';
import ActivityShare from '../models/ActivityShare.js';
import Course from '../models/Course.js';
import Session from '../models/Session.js';

const CODE_PATTERN = /^S-[A-F0-9]{40}$/;

export function normalizeActivityCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return CODE_PATTERN.test(code) ? code : '';
}

export function hashActivityCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

export function makeActivityCode() {
  return `S-${crypto.randomBytes(20).toString('hex').toUpperCase()}`;
}

export async function issueActivityCode(sessionId, expiresAt) {
  const code = makeActivityCode();
  const now = new Date();
  const share = await ActivityShare.findOneAndUpdate(
    { sessionId },
    {
      $set: { codeHash: hashActivityCode(code), enabled: true, expiresAt, updatedAt: now },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true, returnDocument: 'after', runValidators: true }
  ).lean();
  return { code, share };
}

export async function hasActivityGrant(sessionId, userId) {
  const share = await ActivityShare.findOne({ sessionId, enabled: true })
    .select('accessEpoch').lean();
  if (!share) return false;
  return !!(await ActivityGrant.exists({ sessionId, userId, accessEpoch: share.accessEpoch }));
}

// Existing grants survive code rotation and expiry. Disabling the share
// increments accessEpoch, permanently revoking earlier grants. The eventual
// participant routes must call hasActivityGrant.
export async function redeemActivityCode(rawCode, userId) {
  const code = normalizeActivityCode(rawCode);
  if (!code || !userId) return null;
  const now = new Date();
  const share = await ActivityShare.findOne({
    codeHash: hashActivityCode(code), enabled: true, expiresAt: { $gt: now },
  }).lean();
  if (!share) return null;

  const session = await Session.findById(share.sessionId)
    .select('_id name courseId quiz practiceQuiz studentCreated anonymous participationStarted')
    .lean();
  if (!session || session.practiceQuiz || session.studentCreated) return null;
  const course = await Course.findById(session.courseId).select('inactive').lean();
  if (!course || course.inactive) return null;

  // This claim races safely with an instructor changing identity mode: the
  // setting update requires participationStarted to remain false.
  const anonymityFilter = session.anonymous ? { anonymous: true } : { anonymous: { $ne: true } };
  const claimed = await Session.updateOne(
    { _id: session._id, ...anonymityFilter },
    { $set: { participationStarted: true } }
  );
  if (!claimed.matchedCount) return null;

  // A concurrent disable must not issue an effective grant. Rotation can race
  // with a redemption already underway; that redemption may finish.
  const stillEnabled = await ActivityShare.exists({ _id: share._id, enabled: true });
  if (!stillEnabled) return null;
  const grantFilter = { sessionId: session._id, userId: String(userId) };
  try {
    await ActivityGrant.updateOne(
      grantFilter,
      { $max: { accessEpoch: share.accessEpoch }, $setOnInsert: { createdAt: now } },
      { upsert: true, setDefaultsOnInsert: true }
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
    // Two requests for the same account may race the unique grant index.
    await ActivityGrant.updateOne(grantFilter, { $max: { accessEpoch: share.accessEpoch } });
  }
  const currentShare = await ActivityShare.exists({
    _id: share._id, enabled: true, accessEpoch: share.accessEpoch,
  });
  if (!currentShare) return null;
  return { sessionId: session._id, name: session.name, quiz: !!session.quiz, anonymous: !!session.anonymous };
}
