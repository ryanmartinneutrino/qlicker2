# Live Session Speed Improvement Plan

## Purpose

Qlicker currently passes the 500-student live-session load test without lost
responses or failed requests. This document records the next performance work
to consider if production telemetry or instructor reports show noticeable lag.
It is a plan, not a requirement for the current deployment.

The latest 500-student baseline was:

| Signal | Result |
| --- | ---: |
| Successful and professor-observed responses | 2,500 / 2,500 |
| Response processing on the server, p95 | 108 ms |
| Server emit to professor observer, median | 17 ms |
| Server emit to professor observer, p95 | 2.34 s |
| Complete response-to-professor latency, p95 | 2.37 s |
| Professor event synchronization, p99 | 2.61 s |
| Professor action latency, p95 | 331 ms |
| k6 professor observer loop lag, p95 | 1 ms |

The low observer loop lag indicates that the slow tail is primarily in the
Redis/WebSocket delivery path during concentrated response waves, rather than
k6 being unable to schedule its professor observer. Most events arrive quickly,
but the professor connection can accumulate a queue when hundreds of responses
arrive close together.

## Non-negotiable behavior

Any optimization must retain these properties:

- Every accepted response is durably recorded exactly once.
- The professor's response count and statistics converge to the exact result.
- Professor controls remain immediate. Question changes, attempts, response
  open/close, question visibility, stats visibility, correct-answer visibility,
  session status, and session end must never wait behind response batching.
- The presentation window updates at least as quickly as the professor's main
  live-session window.
- Students see newly enabled statistics promptly without clicking or focusing
  the page, including when moving forward or backward between questions.
- Students never receive another student's private response, student identity,
  hidden statistics, or correct-answer content before it is authorized.
- Pending work for an old question or attempt must not update the current one.
- Reconnection and polling fallbacks must still recover the canonical state.

## Why response bursts are the first target

The response route already updates cached attempt statistics atomically, and
server processing is healthy. The expensive pattern happens afterward:

1. Each accepted response produces a `session:response-added` event.
2. Instructors receive an aggregate snapshot for every response.
3. When student statistics are visible, every joined student also receives an
   aggregate snapshot for every response.
4. Short-answer and numerical snapshots can contain a growing answer list, so
   repeatedly sending the full list produces quadratic payload growth over a
   response wave.

For example, 500 responses spread over two seconds can generate 500 successive
professor updates. With student statistics visible, those updates may also be
fanned out to 500 student connections. A browser cannot usefully paint 250
distinct states per second; it only needs a recent, correct state at a smooth
interactive rate.

## Recommended implementation

### 1. Preserve a priority lane for control events

Classify WebSocket events into two groups:

- **Immediate, lossless control events:** question/status/visibility changes,
  attempts, generated visualization visibility, joins, session end, and other
  instructor actions.
- **Coalescible data events:** successive response-count/statistics updates for
  the same session, question, and attempt.

Control events must bypass response batching and any queued response snapshots.
When a control event changes the current question, attempt, `showStats`, or
`showCorrect`, invalidate incompatible pending response updates before emitting
the control event.

### 2. Coalesce response updates into short windows

Introduce a server-side response-update coordinator keyed by:

```text
sessionId + questionId + attemptNumber + audience
```

Start with a 50-100 ms window. During that window, retain the newest canonical
aggregate and collect only the response entries required for instructor lists.
At the end of the window, emit one update representing all accepted responses
in that batch. This caps the visible update rate at 10-20 updates per second,
which is still effectively immediate to a person while greatly reducing Redis,
socket, JSON, and React work.

Each update should contain:

- session, question, and attempt identifiers;
- the latest canonical `responseCount` and `joinedCount`;
- a monotonic revision or count that lets clients reject older snapshots;
- the latest aggregate distribution/summary;
- for instructor short-answer and numerical views, newly added response entries
  rather than the entire growing list;
- the server emission timestamp used by live telemetry.

Do not delay the HTTP response while waiting for the batch to flush. Persistence
and the HTTP acknowledgement remain on the existing request path; coalescing
only affects redundant live notifications.

### 3. Make coalescing safe across server instances

A process-local timer alone is insufficient when submissions can land on
multiple Qlicker instances. The coordinator needs one of these designs:

1. A Redis-backed per-key dirty marker plus a short-lived flush lease, where the
   lease holder reads the latest canonical aggregate and broadcasts it.
2. A small dedicated aggregation worker consuming response notifications from a
   Redis stream and emitting coalesced snapshots.

The Redis stream/worker design is the more robust long-term option because it
survives process restarts and makes lag observable. A lease-based design is a
reasonable first implementation if it includes expiry, recovery, and a final
canonical reconciliation.

Every payload must carry a monotonic revision. Multiple instances may still
produce overlapping snapshots during a lease handoff, so clients must apply a
snapshot only if it is newer than the last applied revision for that
session/question/attempt.

### 4. Build instructor and student payloads separately at flush time

Never sanitize an instructor payload after it has been queued and then reuse it
for students. At flush time, construct the two audiences independently from the
current canonical state.

Before sending a student update, re-check all of the following:

- the session is still running;
- the question and attempt are still current;
- the question is visible;
- live statistics are currently enabled;
- correct-answer fields are included only when `showCorrect` is currently true;
- response lists are included only when their visibility setting permits it;
- recipients are still joined and authorized course members.

This flush-time check prevents a queued payload created while statistics or the
correct answer were visible from leaking after the professor turns them off.
Visibility-off events should additionally invalidate pending student batches.

### 5. Merge deltas in the clients and reconcile periodically

The professor and presentation clients should merge response batches by stable
response ID and replace aggregate statistics with the newest revision. Student
clients should replace only the sanitized aggregate supplied for their audience.

Clients must ignore events for an old question/attempt and revisions older than
the state already rendered. A periodic or reconnect-time `/live` fetch remains
the correctness backstop. The existing immediate handlers for control events
must stay separate from response coalescing.

### 6. Add socket backpressure protection

After application-level coalescing is proven, add a last line of protection in
the WebSocket layer:

- Observe each socket's buffered bytes and send-callback delay.
- Never discard or reorder control events.
- For coalescible response snapshots with the same key, keep only the newest
  unsent snapshot when a socket is backed up.
- Close and reconnect a persistently unhealthy socket rather than allowing an
  unbounded queue; the reconnecting client obtains a canonical `/live` snapshot.

This should be a second phase, because global response coalescing removes more
work and is easier to reason about than per-socket queue manipulation.

### 7. Consider avoiding the local Redis round trip

The current WebSocket publisher sends through Redis even when the target socket
is connected to the publishing instance. A later optimization could deliver to
local sockets immediately and publish an envelope containing an instance ID for
remote instances; the originating subscriber would ignore its own envelope.

Only pursue this after measuring Redis publish-to-subscribe time. It adds
duplicate-delivery and ordering risks, so it should not precede response
coalescing or backpressure instrumentation.

## Measurements to add before optimization

Production dashboards should separate latency by role, event, and stage:

- response request start to database/statistics completion;
- server emit to WebSocket receipt;
- WebSocket receipt to painted UI (`server_emit_to_dom_ms` already covers the
  complete emit-to-paint path);
- Redis publish-to-subscribe duration;
- WebSocket `bufferedAmount`, send-callback latency, and queue depth;
- response-batch size, flush duration, and coalescing ratio;
- stale/duplicate revisions rejected by clients;
- canonical reconciliation corrections;
- server event-loop lag, CPU, memory, MongoDB latency, and Redis latency.

Suggested production warning signals are:

- control-event emit-to-paint p95 above 500 ms for five minutes;
- professor response-update emit-to-paint p95 above 1 second for five minutes;
- professor response-update p99 above 2 seconds;
- sustained WebSocket queue growth or buffered data above a tested limit;
- any mismatch between accepted responses and the final canonical count;
- any unauthorized-field/security assertion failure.

The thresholds should be adjusted after observing normal production classes.

## Validation plan

### Correctness and privacy tests

Add automated tests for:

- multiple responses combined into one professor update;
- exact final totals despite duplicate or out-of-order snapshots;
- short-answer/numerical batches merging without missing or duplicate entries;
- pending batches invalidated on question and attempt changes;
- stats and correct-answer toggles in both directions during a response burst;
- moving forward and backward to a question whose stats are already enabled;
- presentation, professor, and student clients reaching the same authorized
  state without a click/focus event;
- no student event containing identities, hidden responses, or hidden answers;
- reconnect during a batch and recovery from `/live`;
- multiple application instances racing to flush the same key.

### Load-test matrix

Run 50-, 200-, 500-, and optionally 1,000-student scenarios with:

- realistic two-second response jitter;
- a worst-case near-simultaneous response burst;
- student statistics off and on;
- multiple-choice, multiple-select, short-answer, and numerical questions;
- chat enabled and disabled;
- stats/correct toggles and question navigation during active submissions;
- at least two Qlicker instances when validating the Redis coordinator.

Keep the current exact assertions for attempted, accepted, and accounted-for
responses. Since coalescing deliberately reduces the number of professor events,
replace the assumption of one professor event per response with assertions that:

- the batch metadata accounts for every accepted response;
- the final professor revision/count equals the accepted response count;
- the final rendered aggregate matches a canonical `/live` fetch;
- control-event counts remain exact and uncoalesced.

Suggested performance goals at 500 students are:

| Signal | Goal |
| --- | ---: |
| Server response processing p95 | under 250 ms |
| Control event server-emit-to-painted-UI p95 | under 500 ms |
| Professor response update server-emit-to-painted-UI p95 | under 750 ms |
| Professor response update server-emit-to-painted-UI p99 | under 1.5 s |
| Student visible-stat update p95 | under 1 s |
| Lost responses or authorization violations | zero |

## Rollout sequence

1. **Deploy and observe the current implementation.** Record browser telemetry
   for representative production sessions; do not optimize solely from k6.
2. **Add server/Redis/socket queue instrumentation.** Confirm where the tail is
   accumulating.
3. **Implement response coalescing behind an environment feature flag.** Keep
   control events on the existing immediate path.
4. **Validate security, correctness, multi-instance behavior, and the complete
   load-test matrix.** Compare event volume and browser telemetry with baseline.
5. **Canary the feature for selected courses or one application instance.**
   Automatically disable it if counts diverge or latency worsens.
6. **Add per-socket latest-wins backpressure handling only if queues remain.**
7. **Evaluate local-first delivery only if Redis timing proves material.**

The feature flag must permit an immediate rollback to the current event path.
Retain canonical `/live` reconciliation in both modes.

## When to begin this work

Do not undertake the higher-risk batching changes merely because the synthetic
test has a 2.34-second p95 tail. Start implementation if production browser
telemetry confirms sustained response-update lag, control events are delayed,
or instructors report visible burst-time lag. If production control events stay
fast and response statistics remain smooth, continued monitoring is preferable
to introducing distributed-coordination complexity.
