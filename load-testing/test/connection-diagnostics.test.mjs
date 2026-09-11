import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectionFailureDetails } from '../scenarios/connection-diagnostics.js';

test('connection failures expose timing phases without leaking credentials', () => {
  const details = connectionFailureDetails({
    status: 0,
    error_code: 1050,
    error: 'timeout wss://example.com/ws?token=secret-token',
    url: 'wss://example.com/ws?token=secret-token',
    request: { body: '{"password":"secret-password"}' },
    headers: { Authorization: 'Bearer secret-token' },
    timings: { blocked: 60000, connecting: 60000, tls_handshaking: 0, waiting: 0, duration: 0 },
  }, 'student');
  assert.deepEqual(details, {
    role: 'student', status: 0, errorCode: 1050,
    timings: { blocked: 60000, connecting: 60000, tlsHandshaking: 0, waiting: 0, duration: 0 },
  });
  assert.doesNotMatch(JSON.stringify(details), /secret|password|token|example\.com/);
});

test('an absent WebSocket response still produces safe diagnostics', () => {
  assert.deepEqual(connectionFailureDetails(undefined, 'professor'), {
    role: 'professor', status: 0, errorCode: 0,
    timings: { blocked: 0, connecting: 0, tlsHandshaking: 0, waiting: 0, duration: 0 },
  });
});
