/** Anonymous interactive classroom load with count-only WebSocket checks. */
import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';

const state = JSON.parse(open(__ENV.STATE_FILE || '/state/state.json'));
const students = new SharedArray('anonymous live students', () => state.students);
const API = `${__ENV.BASE_URL || 'http://localhost:3001'}/api/v1`;
const WS_URL = (__ENV.BASE_URL || 'http://localhost:3001').replace(/^http/, 'ws') + '/ws';
const sessionId = state.session.id;
const questions = state.questions || [];
const external = !!state.session.external;
const anonymous = !!state.session.anonymous;
const metricPrefix = external ? 'external_live' : 'anonymous';
const answerWindowSeconds = Math.max(5, Number(__ENV.ANSWER_WINDOW_S ?? 20));
const joinGraceSeconds = Math.max(5, Number(__ENV.JOIN_GRACE_S ?? 15));
const answerJitterMs = Math.max(0, Number(__ENV.RESPONSE_JITTER_MS ?? 2000));
const loginSpreadSeconds = Math.max(0, Number(__ENV.STUDENT_LOGIN_SPREAD_S ?? 12));
const maxSessionMs = (joinGraceSeconds + questions.length * (answerWindowSeconds + 3) + 60) * 1000;

if (state.session.quiz || (!anonymous && !external)) {
  throw new Error('The live scenario requires an anonymous or external interactive fixture');
}

const joinDuration = new Trend(`${metricPrefix}_join_duration`, true);
const respondDuration = new Trend(`${metricPrefix}_respond_duration`, true);
const liveRefreshDuration = new Trend(`${metricPrefix}_live_refresh_duration`, true);
const eventDeliveryDuration = new Trend(`${metricPrefix}_event_delivery_duration`, true);
const resultsDuration = new Trend(`${metricPrefix}_results_duration`, true);
const joinSuccess = new Rate(`${metricPrefix}_join_success`);
const respondSuccess = new Rate(`${metricPrefix}_respond_success`);
const privacySuccess = new Rate(`${metricPrefix}_privacy_success`);
const wsSuccess = new Rate(`${metricPrefix}_ws_success`);
const resultsSuccess = new Rate(`${metricPrefix}_results_success`);
const completedStudents = new Counter(`${metricPrefix}_completed_students`);
const submittedAnswers = new Counter(`${metricPrefix}_submitted_answers`);
const instructorResponseEvents = new Counter(`${metricPrefix}_instructor_response_events`);
const redeemDuration = new Trend('external_live_redeem_duration', true);
const redeemSuccess = new Rate('external_live_redeem_success');
const ungradedSuccess = new Rate('external_live_ungraded_success');

export const options = {
  scenarios: {
    professor: { executor: 'shared-iterations', vus: 1, iterations: 1, exec: 'professorFlow', maxDuration: '20m' },
    observer: { executor: 'shared-iterations', vus: 1, iterations: 1, exec: 'observerFlow', startTime: '1s', maxDuration: '20m' },
    students: {
      executor: 'per-vu-iterations', vus: students.length, iterations: 1,
      exec: 'studentFlow', startTime: '3s', maxDuration: '20m',
    },
  },
  thresholds: {
    http_req_failed: [{ threshold: 'rate==0', abortOnFail: true }],
    ...(external ? {
      external_live_redeem_success: ['rate==1'],
      external_live_ungraded_success: ['rate==1'],
      external_live_redeem_duration: ['p(95)<3000'],
    } : {}),
    [`${metricPrefix}_join_success`]: ['rate==1'],
    [`${metricPrefix}_respond_success`]: ['rate==1'],
    [`${metricPrefix}_privacy_success`]: ['rate==1'],
    [`${metricPrefix}_ws_success`]: ['rate==1'],
    [`${metricPrefix}_results_success`]: ['rate==1'],
    [`${metricPrefix}_completed_students`]: [`count==${students.length}`],
    [`${metricPrefix}_submitted_answers`]: [`count==${students.length * questions.length}`],
    [`${metricPrefix}_instructor_response_events`]: [`count==${students.length * questions.length}`],
    [`${metricPrefix}_join_duration`]: ['p(95)<3000'],
    [`${metricPrefix}_respond_duration`]: ['p(95)<3000'],
    [`${metricPrefix}_event_delivery_duration`]: ['p(99)<3000'],
    [`${metricPrefix}_results_duration`]: ['p(95)<3000'],
  },
};

function headers(token) {
  return {
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function request(method, path, token, payload, name) {
  return http.request(method, `${API}${path}`, payload === undefined ? null : JSON.stringify(payload), {
    headers: headers(token), tags: { name },
  });
}

function body(response) {
  try { return response.json(); } catch { return {}; }
}

function login(account) {
  const response = request('POST', '/auth/login', '', {
    email: account.email, password: state.password,
  }, 'anonymous_login');
  return response.status === 200 ? body(response).token : null;
}

function live(token) {
  const response = request('GET', `/sessions/${sessionId}/live`, token, undefined, 'anonymous_live');
  liveRefreshDuration.add(response.timings.duration);
  return response.status === 200 ? body(response) : null;
}

function answerFor(question, index) {
  switch (Number(question.type)) {
    case 0: return '1';
    case 1: return '0';
    case 2: return `Anonymous survey answer ${index % 8}`;
    case 3: return ['0', '2', '4'];
    case 4: return '3.14';
    default: return '0';
  }
}

function professorAction(method, path, token, payload) {
  const response = request(method, `/sessions/${sessionId}${path}`, token, payload, 'anonymous_professor_action');
  check(response, { 'anonymous professor action succeeds': (result) => result.status === 200 });
  if (response.status !== 200) console.error(`Professor action ${path} failed: ${response.status}`);
  return response;
}

export function professorFlow() {
  const token = login(state.professor);
  if (!token) throw new Error('Anonymous live professor login failed');
  professorAction('PATCH', '/current', token, { questionId: questions[0].id });
  professorAction('PATCH', '/question-visibility', token, { hidden: true, stats: false, correct: false });
  professorAction('POST', '/start', token, {});
  sleep(joinGraceSeconds);

  for (const [index, question] of questions.entries()) {
    if (index > 0) {
      professorAction('PATCH', '/question-visibility', token, { hidden: true, stats: false, correct: false });
      professorAction('PATCH', '/current', token, { questionId: question.id });
    }
    professorAction('POST', '/new-attempt', token, {});
    professorAction('PATCH', '/question-visibility', token, { hidden: false, stats: false, correct: false });
    sleep(answerWindowSeconds);
    professorAction('PATCH', '/toggle-responses', token, { closed: true });
    const snapshot = live(token);
    const privateSnapshot = !!snapshot
      && snapshot.responseCount === students.length
      && (!anonymous || (Array.isArray(snapshot.allResponses)
        && snapshot.allResponses.length === 0
        && snapshot.responseStats == null));
    privacySuccess.add(privateSnapshot);
    check(snapshot, { 'instructor sees count only after question': () => privateSnapshot });
    professorAction('PATCH', '/question-visibility', token, { hidden: false, stats: true, correct: false });
    sleep(1);
  }

  professorAction('POST', '/end', token, {});
  const results = request('GET', `/sessions/${sessionId}/results`, token, undefined, 'anonymous_final_results');
  resultsDuration.add(results.timings.duration);
  const payload = body(results);
  const expectedRows = anonymous && students.length < 4 ? 0 : students.length;
  const serialized = JSON.stringify(payload);
  const rows = payload.studentResults || [];
  const answersCorrelate = rows.length === 0 || rows.every((row) =>
    questions.every((question) => row.questionResults?.some((result) =>
      String(result.questionId) === String(question.id) && result.responses?.length === 1)));
  const okay = results.status === 200
    && rows.length === expectedRows
    && answersCorrelate
    && (!anonymous || (!serialized.includes('anon_')
      && !serialized.includes(students[0].id)
      && !serialized.includes(students[0].email)));
  if (external) {
    const grades = request('GET', `/sessions/${sessionId}/grades`, token, undefined, 'external_live_ungraded');
    const noGrades = grades.status === 200 && (body(grades).grades || []).length === 0;
    ungradedSuccess.add(noGrades);
    check(grades, { 'shared live session has no grades': () => noGrades });
  }
  resultsSuccess.add(okay);
  check(results, { 'final anonymous rows are private and complete': () => okay });
}

export function observerFlow() {
  const token = login(state.professor);
  if (!token) {
    wsSuccess.add(false);
    return;
  }
  const response = ws.connect(`${WS_URL}?token=${encodeURIComponent(token)}`, {}, (socket) => {
    socket.on('open', () => wsSuccess.add(true));
    socket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw); } catch { return; }
      const data = message?.data || {};
      if (String(data.sessionId || '') !== String(sessionId)) return;
      if (message.event === 'session:response-added') {
        instructorResponseEvents.add(1);
        const privateEvent = !anonymous || (data.response == null
          && data.responseStats == null
          && data.responseSubmittedAt == null);
        privacySuccess.add(privateEvent);
        const emittedAt = Date.parse(data.emittedAt || '');
        if (Number.isFinite(emittedAt)) eventDeliveryDuration.add(Math.max(0, Date.now() - emittedAt));
      }
      if (message.event === 'session:status-changed' && data.status === 'done') socket.close();
    });
    socket.setInterval(() => socket.send(JSON.stringify({ event: 'ping' })), 15000);
    socket.setTimeout(() => socket.close(), maxSessionMs);
  });
  if (response?.status !== 101) wsSuccess.add(false);
}

export function studentFlow() {
  const index = exec.scenario.iterationInTest;
  const student = students[index];
  if (!student) throw new Error(`Missing student for VU ${index + 1}`);
  if (loginSpreadSeconds) sleep((index % 101) / 101 * loginSpreadSeconds);
  const token = login(student);
  if (!token) {
    joinSuccess.add(false);
    return;
  }
  if (external) {
    const redeemed = request('POST', '/activity-codes/redeem', token, {
      code: state.session.activityCode,
    }, 'external_live_redeem');
    redeemDuration.add(redeemed.timings.duration);
    const accepted = redeemed.status === 200 && body(redeemed).sessionId === sessionId;
    redeemSuccess.add(accepted);
    if (!accepted) {
      console.error(`Live code redemption failed for participant ${index + 1}: ${redeemed.status}`);
      return;
    }
  }
  live(token);
  let joined = false;
  for (let attempt = 0; attempt < 20 && !joined; attempt += 1) {
    const response = request('POST', `/sessions/${sessionId}/join`, token, {}, 'anonymous_join');
    joinDuration.add(response.timings.duration);
    joined = response.status === 200;
    if (!joined) sleep(0.5);
  }
  joinSuccess.add(joined);
  if (!joined) return;

  const answered = new Set();
  const scheduled = new Set();
  let ended = false;
  const response = ws.connect(`${WS_URL}?token=${encodeURIComponent(token)}`, {}, (socket) => {
    const refreshAndRespond = () => {
      const snapshot = live(token);
      const questionId = String(snapshot?.currentQuestion?._id || snapshot?.questionId || '');
      const attempt = Number(snapshot?.currentAttempt?.number || 0);
      const question = questions.find((entry) => entry.id === questionId);
      const key = `${questionId}:${attempt}`;
      if (!question || !attempt || snapshot?.questionHidden || snapshot?.currentAttempt?.closed
        || snapshot?.studentResponse || answered.has(key) || scheduled.has(key)) return;
      scheduled.add(key);
      socket.setTimeout(() => {
        const saved = request('POST', `/sessions/${sessionId}/respond`, token, {
          answer: answerFor(question, index),
        }, 'anonymous_respond');
        respondDuration.add(saved.timings.duration);
        const ok = saved.status === 201;
        respondSuccess.add(ok);
        if (ok) {
          answered.add(key);
          submittedAnswers.add(1);
        } else {
          console.error(`Anonymous answer failed for student ${index + 1}: ${saved.status}`);
        }
        scheduled.delete(key);
      }, Math.max(1, answerJitterMs ? (index * 17 + questions.indexOf(question) * 31) % (answerJitterMs + 1) : 1));
    };
    socket.on('open', () => {
      wsSuccess.add(true);
      refreshAndRespond();
      socket.setInterval(() => socket.send(JSON.stringify({ event: 'ping' })), 15000);
    });
    socket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw); } catch { return; }
      const data = message?.data || {};
      if (String(data.sessionId || '') !== String(sessionId)) return;
      if (message.event === 'session:response-added') {
        privacySuccess.add(!anonymous || (data.response == null && data.responseStats == null && data.responseSubmittedAt == null));
      }
      if (message.event === 'session:question-changed'
        || message.event === 'session:visibility-changed'
        || message.event === 'session:attempt-changed') refreshAndRespond();
      if (message.event === 'session:status-changed' && data.status === 'done') {
        ended = true;
        socket.close();
      }
    });
    socket.setTimeout(() => socket.close(), maxSessionMs);
  });
  if (response?.status !== 101) wsSuccess.add(false);
  if (ended && answered.size === questions.length) completedStudents.add(1);
  else console.error(`Anonymous student ${index + 1} completed ${answered.size}/${questions.length} answers; ended=${ended}`);
}
