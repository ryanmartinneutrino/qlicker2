// Keep URLs, headers, bodies and raw errors out of diagnostics: WebSocket URLs
// contain access tokens, and login bodies contain passwords.
export function connectionFailureDetails(response, role) {
  const numberOrZero = (value) => Number.isFinite(value) ? value : 0;
  return {
    role,
    status: numberOrZero(response?.status),
    errorCode: numberOrZero(response?.error_code),
    timings: {
      blocked: numberOrZero(response?.timings?.blocked),
      connecting: numberOrZero(response?.timings?.connecting),
      tlsHandshaking: numberOrZero(response?.timings?.tls_handshaking),
      waiting: numberOrZero(response?.timings?.waiting),
      duration: numberOrZero(response?.timings?.duration),
    },
  };
}
