# Epic 7: Multi-Device Acoustic Room Mapping

> **Priority:** P1 - High
> **Effort:** 12 weeks (3 epochs)
> **Owner:** Joshua Seppich
> **Dependencies:** Epic 2 (acoustic pipeline), hypervisor/server.js (port 3333)

## Overview

Single-device acoustic mapping has three fundamental hardware limitations: (1) direct-path
speaker→mic coupling overwhelms early echoes, (2) iOS AEC silently cancels the ESS sweep
before it reaches the mic, (3) a single mic yields distance only — no angular bearing to walls.

Using two devices (phone + laptop) solves all three. Separating emitter and recorder eliminates
coupling. Cross-device measurement routes around AEC entirely. Two spatially separated mics
enable TDOA-based bearing estimation. The WebSocket relay in `hypervisor/server.js` already
exists; this epic builds the protocol, geometry, and UI on top of it.

## Architecture

```
Hypervisor (server.js:3333)  — WebSocket relay
  ├── Device A (Emitter)     — plays ESS sweeps
  ├── Device B (Recorder)    — captures echoes, runs deconvolution locally
  └── Clock sync via NTP-like ping/pong (<1ms on LAN)
        │
        ├── Feature-level data sharing (echo peaks, not raw PCM — <10KB/s)
        └── Geometry fusion: elliptical constraints for separated paths
               9-parameter joint solver [Lx,Ly,Lz, p1x,p1y,p1z, p2x,p2y,p2z]
               Baseline constraint couples device positions for conditioning
```

**Key design decisions:**
- Feature-level sharing keeps bandwidth under 10KB/s — raw PCM at 48kHz is ~3MB/s per device
- NTP-like clock sync (not acoustic sync) — works without simultaneous mic access on both devices
- 9-parameter joint solver — existing `gaussianElimination` scales to 9×9 without changes
- Separated path geometry uses elliptical constraints (speaker→wall→mic), not round-trip/2

---

## Epoch 1: Device Coordination (Weeks 1–4)

### PRD 7.1: WebSocket Signaling & Room Pairing

**Problem:** There is no mechanism for two devices to discover each other, agree on roles,
or coordinate timing. Without this, cross-device measurement is impossible.

### Requirements

| ID | Requirement | Priority |
|---|---|---|
| MDV-01 | Two devices pair via a 4-digit room code | Must |
| MDV-02 | Message protocol covers: device-announce, role-assign, clock-ping/pong, sweep-trigger, echo-data, geometry-update | Must |
| MDV-03 | Clock offset estimated to <1ms on LAN via 10-sample NTP-like burst | Must |
| MDV-04 | Roles (Emitter / Recorder / Both) assignable and swappable via UI | Must |
| MDV-05 | Sweep trigger coordinated so recorder opens capture window before emitter fires | Must |

### PRD 7.2: Separated Emission/Recording Pipeline

**Problem:** Even with two paired devices, the recording pipeline assumes local loopback.
Separated emission requires remote echo extraction, cross-device deconvolution, and
a geometry model that handles non-collocated speaker and mic.

### Requirements

| ID | Requirement | Priority |
|---|---|---|
| MDV-06 | Recorder runs deconvolution locally; shares peaks only (<2KB/sweep) | Must |
| MDV-07 | Wall constraint uses elliptical path length (speaker→wall→mic), not round-trip/2 | Must |
| MDV-08 | Both devices rendered on map (local=cyan, remote=orange, baseline dashed) | Must |

### Epoch 1 Tickets

| ID | Title | Effort | Deps |
|---|---|---|---|
| MDV-T01 | WebSocket support in server.js (ws package, /ws/room/:id) | M | — |
| MDV-T02 | Message protocol (device-announce, role-assign, clock-ping/pong, sweep-trigger, echo-data, geometry-update) | S | T01 |
| MDV-T03 | Room pairing UI (4-digit code, create/join, status banner) | M | T01–02 |
| MDV-T04 | Role assignment (Emitter/Recorder/Both, swap UI) | M | T03 |
| MDV-T05 | NTP-like clock sync (10-sample burst, IQR filter, <1ms target on LAN) | L | T01–02 |
| MDV-T06 | Sweep trigger sync (emitter sends trigger, recorder acks, coordinated record window) | M | T04–05 |
| MDV-T07 | Remote echo extraction (recorder runs deconvolution locally, shares peaks not PCM, <2KB/sweep) | L | T06 |
| MDV-T08 | Elliptical wall constraint (separated path: speaker→wall→mic, not round-trip/2) | L | T07 |
| MDV-T09 | Fused visualization (both devices on map, local=cyan, remote=orange, baseline dashed) | M | T08 |

#### TICKET MDV-T01: WebSocket support in server.js
**Type:** Setup
**Points:** 5

**Description:**
Add `ws` package to `hypervisor/server.js` and expose a `/ws/room/:id` endpoint. The
hypervisor already runs HTTP on port 3333; this adds a WebSocket upgrade path alongside
it. Rooms are ephemeral (in-memory map, GC'd on last disconnect).

**Acceptance Criteria:**
- `ws` installed and server starts without error on port 3333
- `/ws/room/:id` accepts connections; messages relayed to all other sockets in the same room
- Room map cleaned up when last member disconnects
- Server logs: connection, message type, and disconnect events

**Smoke Test:**
```typescript
// smoke/mdv-t01.test.ts
describe('WebSocket relay', () => {
  it('relays messages between two clients in the same room', async () => {
    const a = new WebSocket('ws://localhost:3333/ws/room/test01');
    const b = new WebSocket('ws://localhost:3333/ws/room/test01');
    await Promise.all([waitOpen(a), waitOpen(b)]);
    const received = waitMessage(b);
    a.send(JSON.stringify({ type: 'ping', from: 'a' }));
    const msg = await received;
    expect(JSON.parse(msg).type).toBe('ping');
  });

  it('does not relay messages to clients in a different room', async () => {
    const a = new WebSocket('ws://localhost:3333/ws/room/roomA');
    const c = new WebSocket('ws://localhost:3333/ws/room/roomB');
    await Promise.all([waitOpen(a), waitOpen(c)]);
    const spy = jest.fn();
    c.onmessage = spy;
    a.send(JSON.stringify({ type: 'test' }));
    await delay(200);
    expect(spy).not.toHaveBeenCalled();
  });
});
```

---

#### TICKET MDV-T02: Message protocol definition
**Type:** Setup
**Points:** 2

**Description:**
Define and document the full message protocol as a TypeScript interface file. All
subsequent tickets implement against this contract. Messages are JSON with a `type`
discriminant and a `deviceId` field.

**Acceptance Criteria:**
- `src/multiDevice/protocol.ts` exports typed message interfaces for all 7 message types
- Each message type has a JSDoc comment explaining timing requirements or payload constraints
- No runtime code — types only

**Smoke Test:**
```typescript
// smoke/mdv-t02.test.ts
import { MultiDeviceMessage } from '../src/multiDevice/protocol';
describe('Protocol types', () => {
  it('compiles without errors', () => {
    const msg: MultiDeviceMessage = { type: 'clock-ping', deviceId: 'a', t0: Date.now() };
    expect(msg.type).toBe('clock-ping');
  });
});
```

---

#### TICKET MDV-T03: Room pairing UI
**Type:** Feature
**Points:** 5

**Description:**
Add a pairing screen to `acoustic-mapper.html`: a 4-digit code entry field, Create/Join
buttons, and a persistent status banner (Paired / Waiting / Disconnected). The UI should
be minimal — it lives above the existing mapper UI, not replacing it.

**Acceptance Criteria:**
- User can generate a random 4-digit code or enter one manually
- "Create" opens a room and waits; "Join" connects to an existing room
- Status banner updates in real time as peers connect/disconnect
- Pairing screen collapses once both devices are in the room

**Smoke Test:**
```typescript
// smoke/mdv-t03.test.ts
describe('Room pairing', () => {
  it('transitions to paired state when second device joins', async () => {
    const coordinator = new RoomCoordinator('ws://localhost:3333');
    await coordinator.create('1234');
    expect(coordinator.status).toBe('waiting');
    const peer = new RoomCoordinator('ws://localhost:3333');
    await peer.join('1234');
    await delay(100);
    expect(coordinator.status).toBe('paired');
  });
});
```

---

#### TICKET MDV-T04: Role assignment
**Type:** Feature
**Points:** 5

**Description:**
After pairing, allow each device to declare its role: Emitter (plays sweeps), Recorder
(captures audio), or Both (single-device fallback). Roles should be swappable via a button
so the user can reposition devices without re-pairing.

**Acceptance Criteria:**
- Role picker shown after pairing (Emitter / Recorder / Both)
- Role broadcast to peer via `role-assign` message
- Roles displayed on both devices' status banners
- Swap button sends updated `role-assign`; both UIs update within 200ms
- "Both" role disables remote coordination (graceful single-device fallback)

**Smoke Test:**
```typescript
// smoke/mdv-t04.test.ts
describe('Role assignment', () => {
  it('propagates role to peer', async () => {
    const [a, b] = await pairedPair();
    await a.setRole('emitter');
    await delay(100);
    expect(b.peerRole).toBe('emitter');
  });

  it('swap updates both devices', async () => {
    const [a, b] = await pairedPair();
    await a.setRole('emitter');
    await b.setRole('recorder');
    await a.swapRoles();
    await delay(100);
    expect(a.role).toBe('recorder');
    expect(b.role).toBe('emitter');
  });
});
```

---

#### TICKET MDV-T05: NTP-like clock synchronization
**Type:** Feature
**Points:** 8

**Description:**
Implement a clock sync protocol so both devices share a common timeline. Send 10
ping/pong round-trips, compute RTT for each, discard outliers via IQR filter, and
estimate clock offset as `(t1 - t0 - rtt/2)`. Target: <1ms offset on LAN. Re-sync
every 30 seconds to compensate for drift.

**Acceptance Criteria:**
- 10-sample burst on pair; re-sync every 30s
- IQR filter removes top/bottom 25% of RTT samples
- `clockOffset` value exposed for correcting remote timestamps
- Offset logged after each sync; user-visible sync quality indicator (Good / Poor)
- On LAN: measured offset < 1ms in unit test with artificial delay

**Smoke Test:**
```typescript
// smoke/mdv-t05.test.ts
describe('Clock sync', () => {
  it('converges to <1ms offset on simulated LAN', async () => {
    const syncer = new ClockSyncer({ simulatedLatencyMs: 0.5 });
    const offset = await syncer.sync();
    expect(Math.abs(offset)).toBeLessThan(1);
  });

  it('filters outliers from RTT samples', async () => {
    const samples = [1, 1.1, 0.9, 50, 1.0, 1.2, 0.8, 1.1, 0.95, 1.05];
    const filtered = ClockSyncer.filterIQR(samples);
    expect(filtered.every(s => s < 10)).toBe(true);
  });
});
```

---

#### TICKET MDV-T06: Coordinated sweep trigger
**Type:** Feature
**Points:** 5

**Description:**
Emitter sends a `sweep-trigger` message with an absolute fire time (clock-corrected).
Recorder opens its capture window 50ms before that time. Both devices use the shared
clock offset from MDV-T05 to align. Ack/retry if recorder does not confirm within 500ms.

**Acceptance Criteria:**
- Recorder starts capture window ≥ 20ms before emitter fires
- Emitter waits for `sweep-ack` before firing; retries once after 500ms
- Trigger-to-capture alignment error < 5ms (measurable via direct-path peak offset)
- Works with clock offsets up to ±10ms (beyond LAN, graceful degradation)

**Smoke Test:**
```typescript
// smoke/mdv-t06.test.ts
describe('Sweep trigger', () => {
  it('recorder opens window before emitter fires', async () => {
    const timeline: string[] = [];
    recorder.onCaptureStart = () => timeline.push('record');
    emitter.onSweepFire = () => timeline.push('emit');
    await emitter.triggerSweep();
    expect(timeline[0]).toBe('record');
    expect(timeline[1]).toBe('emit');
  });

  it('retries if ack not received within 500ms', async () => {
    let attempts = 0;
    emitter.onTriggerAttempt = () => attempts++;
    recorder.dropNextAck = true;
    await emitter.triggerSweep();
    expect(attempts).toBe(2);
  });
});
```

---

#### TICKET MDV-T07: Remote echo extraction
**Type:** Feature
**Points:** 8

**Description:**
The Recorder runs deconvolution locally (existing pipeline) and sends only extracted
echo peaks over WebSocket as `echo-data` messages. Payload: array of
`{ delayMs, amplitude, confidence }` objects. Target: <2KB per sweep.
Raw PCM is never transmitted.

**Acceptance Criteria:**
- `echo-data` message carries peak array, sweep ID, recorder device ID, and clock-corrected capture time
- Payload size < 2KB for typical room (≤ 20 peaks)
- Emitter receives and stores peaks tagged with source device ID
- Pipeline works end-to-end with two browser tabs on the same machine (smoke test)

**Smoke Test:**
```typescript
// smoke/mdv-t07.test.ts
describe('Remote echo extraction', () => {
  it('delivers peaks under 2KB', async () => {
    const peaks = await remoteRecorder.extractAndSend(sweepId);
    const payload = JSON.stringify(peaks);
    expect(payload.length).toBeLessThan(2048);
  });

  it('peaks tagged with recorder device ID', async () => {
    const peaks = await emitter.receivePeaks(sweepId);
    expect(peaks.every(p => p.deviceId === recorder.deviceId)).toBe(true);
  });
});
```

---

#### TICKET MDV-T08: Elliptical wall constraint
**Type:** Feature
**Points:** 8

**Description:**
When emitter and recorder are at different positions, a reflected echo arrives via
path `emitter → wall → recorder`. The delay maps to an ellipse with foci at the two
device positions, not a circle centered on either device. Update the geometry solver
to accept elliptical constraints alongside the existing circular ones.

**Acceptance Criteria:**
- `EllipticalConstraint(focus1, focus2, pathLength)` class implemented
- Solver accepts mixed circular and elliptical constraints
- For collocated devices, elliptical constraint degenerates correctly to circular
- Wall position error < 5cm for known geometry in unit test with synthetic echo data

**Smoke Test:**
```typescript
// smoke/mdv-t08.test.ts
describe('Elliptical wall constraint', () => {
  it('resolves to correct wall for known geometry', () => {
    const emitterPos = { x: 1, y: 1 };
    const recorderPos = { x: 3, y: 1 };
    const wallX = 0; // left wall at x=0
    const pathLen = dist(emitterPos, { x: wallX, y: 1 }) + dist({ x: wallX, y: 1 }, recorderPos);
    const constraint = new EllipticalConstraint(emitterPos, recorderPos, pathLen);
    const candidates = constraint.wallCandidates();
    expect(candidates.some(w => Math.abs(w.x - wallX) < 0.05)).toBe(true);
  });

  it('degenerates to circle when foci are collocated', () => {
    const pos = { x: 2, y: 2 };
    const c = new EllipticalConstraint(pos, pos, 4.0);
    expect(c.isCircular()).toBe(true);
  });
});
```

---

#### TICKET MDV-T09: Fused multi-device visualization
**Type:** Feature
**Points:** 5

**Description:**
Render both devices on the room map. Local device: cyan dot. Remote device: orange dot.
A dashed line connects them (the baseline). Echo constraints from each source use their
respective color. The map updates in real time as geometry-update messages arrive.

**Acceptance Criteria:**
- Local device dot: cyan; remote device dot: orange
- Baseline rendered as dashed line between device positions
- Echo arcs/ellipses colored by source device
- Map re-renders within 100ms of receiving `geometry-update`
- Both devices show the same map (geometry broadcast to all room members)

**Smoke Test:**
```typescript
// smoke/mdv-t09.test.ts
describe('Fused visualization', () => {
  it('renders both device positions', () => {
    const map = new RoomMap();
    map.setLocalDevice({ x: 1, y: 1 });
    map.setRemoteDevice({ x: 3, y: 1 });
    expect(map.elements.localDot.color).toBe('cyan');
    expect(map.elements.remoteDot.color).toBe('orange');
    expect(map.elements.baseline).toBeDefined();
  });
});
```

---

## Epoch 2: Robust Separated Measurement (Weeks 5–8)

### PRD 7.3: Hardened Pipeline

**Problem:** A single sweep pair is fragile — noise, movement, or direct-path occlusion
corrupts the measurement. The pipeline needs quality scoring, retry logic, adaptive gain,
and role alternation to produce reliable data.

### PRD 7.4: Multi-Source Geometry Fusion

**Problem:** With two devices producing independent echo sets, the geometry solver must
accept observations tagged by source, handle conflicting constraints gracefully, and solve
for all device positions simultaneously.

### Requirements

| ID | Requirement | Priority |
|---|---|---|
| MDV-09 | Role alternation (A→B then B→A) doubles independent observations | Must |
| MDV-10 | Sweep quality scored (SNR, peak count, consistency); bad sweeps trigger retry | Must |
| MDV-11 | Direct-path occlusion detected and flagged; TDOA disabled when occluded | Should |
| MDV-12 | Adaptive emission gain targets −12 dBFS at recorder | Should |
| MDV-13 | Walking mode streams compressed spectral data (~5KB/s) | Should |
| MDV-14 | 9-parameter joint solver fuses observations from both devices | Must |
| MDV-15 | Geometry broadcast throttled to 2 updates/second | Must |

### Epoch 2 Tickets

| ID | Title | Effort | Deps |
|---|---|---|---|
| MDV-T10 | Role alternation (A emits→B records, then swap, doubles observations) | L | T06–07 |
| MDV-T11 | Sweep quality scoring + retry (SNR, peak count, consistency → retry if >30% bad) | M | T07 |
| MDV-T12 | Direct-path occlusion detection (SNR < 3× noise → disable TDOA, warn user) | M | T07 |
| MDV-T13 | Adaptive emission gain (recorder reports amplitude, emitter adjusts to −12 dBFS target) | S | T06 |
| MDV-T14 | Compressed spectral sharing for walking mode (256-bin magnitude, 100ms windows, ~5KB/s) | M | T07 |
| MDV-T15 | Multi-device observation accumulator (tagged by source, type, position, quality) | M | T08 |
| MDV-T16 | 9-parameter joint solver [Lx,Ly,Lz, p1x,p1y,p1z, p2x,p2y,p2z] + baseline constraint | L | T08–15 |
| MDV-T17 | Cross-device geometry broadcast (geometry-update message, throttled 2/sec) | S | T16 |

#### TICKET MDV-T10: Role alternation
**Type:** Feature
**Points:** 8

**Description:**
After a sweep pair (A emits, B records), swap roles automatically and fire again (B emits,
A records). This doubles the number of independent echo observations and provides symmetric
coverage of the room from both device positions.

**Acceptance Criteria:**
- Alternation triggered automatically after each successful sweep pair
- Each role's peaks stored with emitter/recorder positions attached
- At least 2 alternations before geometry solve attempted
- Total alternation overhead < 2 seconds per cycle

**Smoke Test:**
```typescript
// smoke/mdv-t10.test.ts
describe('Role alternation', () => {
  it('collects peaks from both directions', async () => {
    const session = new MultiDeviceSession();
    await session.runAlternation(2);
    const peaks = session.allPeaks();
    const fromA = peaks.filter(p => p.emitterDevice === 'A');
    const fromB = peaks.filter(p => p.emitterDevice === 'B');
    expect(fromA.length).toBeGreaterThan(0);
    expect(fromB.length).toBeGreaterThan(0);
  });
});
```

---

#### TICKET MDV-T11: Sweep quality scoring and retry
**Type:** Feature
**Points:** 5

**Description:**
Score each sweep on three criteria: SNR of the direct-path peak, total peak count,
and inter-sweep consistency (peak positions stable across last 3 sweeps). If >30% of
sweeps in a session fail any criterion, emit a retry request automatically.

**Acceptance Criteria:**
- Quality score 0–1 computed per sweep; exposed in `echo-data` message
- Retry triggered if rolling 3-sweep pass rate drops below 70%
- Quality indicator shown in UI (green/yellow/red)
- Failed sweeps excluded from geometry accumulator

**Smoke Test:**
```typescript
// smoke/mdv-t11.test.ts
describe('Sweep quality scoring', () => {
  it('scores clean sweep high', async () => {
    const peaks = await loadPeaks('clean-sweep.json');
    expect(QualityScorer.score(peaks)).toBeGreaterThan(0.8);
  });

  it('scores noisy sweep low', async () => {
    const peaks = await loadPeaks('noisy-sweep.json');
    expect(QualityScorer.score(peaks)).toBeLessThan(0.4);
  });

  it('triggers retry after 3 bad sweeps', async () => {
    const scorer = new RollingQualityScorer();
    scorer.add(0.2); scorer.add(0.3); scorer.add(0.25);
    expect(scorer.shouldRetry()).toBe(true);
  });
});
```

---

#### TICKET MDV-T12: Direct-path occlusion detection
**Type:** Feature
**Points:** 5

**Description:**
When the direct-path peak SNR falls below 3× the noise floor, the devices likely have
an obstacle between them. TDOA bearing estimation is unreliable in this case. Detect
occlusion, disable TDOA for that sweep, and warn the user to reposition.

**Acceptance Criteria:**
- Occlusion detected when direct-path SNR < 3× background
- TDOA computation skipped for occluded sweeps
- Warning banner shown: "Direct path blocked — reposition devices"
- Occlusion flag included in `echo-data` message

**Smoke Test:**
```typescript
// smoke/mdv-t12.test.ts
describe('Occlusion detection', () => {
  it('detects occlusion from low SNR direct path', () => {
    const peaks = [{ delayMs: 0.5, amplitude: 0.05, confidence: 0.3 }];
    const noiseFloor = 0.04;
    expect(OcclusionDetector.isOccluded(peaks, noiseFloor)).toBe(true);
  });

  it('passes clear line of sight', () => {
    const peaks = [{ delayMs: 0.5, amplitude: 0.5, confidence: 0.9 }];
    const noiseFloor = 0.04;
    expect(OcclusionDetector.isOccluded(peaks, noiseFloor)).toBe(false);
  });
});
```

---

#### TICKET MDV-T13: Adaptive emission gain
**Type:** Feature
**Points:** 3

**Description:**
After each sweep, the recorder reports the measured direct-path amplitude back to the
emitter. The emitter adjusts its output gain to target −12 dBFS at the recorder. This
prevents clipping in small rooms and inaudible sweeps in large ones.

**Acceptance Criteria:**
- `amplitude-report` message sent by recorder after each sweep
- Emitter adjusts gain by ±3 dB per step toward −12 dBFS target
- Gain clamped to [−18 dB, 0 dB] range
- Converges to target within 4 sweeps in simulation

**Smoke Test:**
```typescript
// smoke/mdv-t13.test.ts
describe('Adaptive gain', () => {
  it('converges to -12dBFS within 4 sweeps', () => {
    const controller = new GainController({ target: -12 });
    let amplitude = -6; // too loud
    for (let i = 0; i < 4; i++) amplitude = controller.adjust(amplitude);
    expect(amplitude).toBeCloseTo(-12, 1);
  });
});
```

---

#### TICKET MDV-T14: Compressed spectral sharing for walking mode
**Type:** Feature
**Points:** 5

**Description:**
In walking mode, the stationary device continuously emits and the moving device streams
compressed spectral snapshots (256-bin FFT magnitude, 100ms windows) back. This enables
real-time position tracking without per-sweep deconvolution latency. Target bandwidth: ~5KB/s.

**Acceptance Criteria:**
- 256-bin magnitude spectrum serialized as Float32Array (1KB per frame)
- Frames sent at 5Hz; receiver reconstructs running cross-correlation
- Bandwidth < 5KB/s at 5Hz
- Latency from capture to receive < 200ms

**Smoke Test:**
```typescript
// smoke/mdv-t14.test.ts
describe('Spectral sharing', () => {
  it('frame payload under 1KB', () => {
    const frame = SpectralEncoder.encode(new Float32Array(256));
    expect(frame.byteLength).toBeLessThan(1024);
  });

  it('maintains <5KB/s at 5Hz', () => {
    const bytesPerSecond = 1024 * 5; // 1KB * 5Hz
    expect(bytesPerSecond).toBeLessThan(5120);
  });
});
```

---

#### TICKET MDV-T15: Multi-device observation accumulator
**Type:** Feature
**Points:** 5

**Description:**
Replace the existing single-device echo accumulator with one that tags each observation
with: source device ID, emitter position, recorder position, sweep quality score, and
timestamp. The geometry solver reads from this accumulator.

**Acceptance Criteria:**
- `ObservationAccumulator.add(observation)` accepts tagged observations
- Observations queryable by device ID, role, quality threshold
- Accumulator serializable for debug/replay
- Old single-device observations remain compatible (emitter === recorder)

**Smoke Test:**
```typescript
// smoke/mdv-t15.test.ts
describe('Observation accumulator', () => {
  it('stores and filters by device', () => {
    const acc = new ObservationAccumulator();
    acc.add({ deviceId: 'A', peaks: [], quality: 0.9 });
    acc.add({ deviceId: 'B', peaks: [], quality: 0.7 });
    expect(acc.forDevice('A').length).toBe(1);
    expect(acc.forDevice('B').length).toBe(1);
  });

  it('filters by quality threshold', () => {
    const acc = new ObservationAccumulator();
    acc.add({ deviceId: 'A', peaks: [], quality: 0.3 });
    acc.add({ deviceId: 'A', peaks: [], quality: 0.9 });
    expect(acc.aboveQuality(0.5).length).toBe(1);
  });
});
```

---

#### TICKET MDV-T16: 9-parameter joint solver
**Type:** Feature
**Points:** 8

**Description:**
Extend the geometry solver to jointly estimate room dimensions and both device positions:
`[Lx, Ly, Lz, p1x, p1y, p1z, p2x, p2y, p2z]`. A baseline constraint
`|p1 − p2| = measured_baseline` is added to couple the two device position estimates
and improve conditioning. The existing `gaussianElimination` function handles 9×9
without changes.

**Acceptance Criteria:**
- Solver accepts mixed circular (single-device) and elliptical (multi-device) constraints
- Baseline constraint added automatically when both device positions are known
- Room dimension error < 5% for synthetic test room with 20+ observations
- Solver falls back to 6-parameter (single device) if second device has no observations

**Smoke Test:**
```typescript
// smoke/mdv-t16.test.ts
describe('9-parameter joint solver', () => {
  it('recovers room and device positions from synthetic data', () => {
    const truth = { Lx: 5, Ly: 4, Lz: 2.5, p1: [1,1,1], p2: [3,1,1] };
    const observations = syntheticObservations(truth, 30);
    const result = JointSolver.solve(observations);
    expect(Math.abs(result.Lx - truth.Lx)).toBeLessThan(0.25);
    expect(Math.abs(result.Ly - truth.Ly)).toBeLessThan(0.25);
  });

  it('falls back to 6-parameter when only one device has data', () => {
    const observations = singleDeviceObservations(20);
    const result = JointSolver.solve(observations);
    expect(result.parameterCount).toBe(6);
  });
});
```

---

#### TICKET MDV-T17: Cross-device geometry broadcast
**Type:** Feature
**Points:** 3

**Description:**
After each solver run, broadcast the updated geometry to all devices in the room via
a `geometry-update` message. Throttle to 2 updates/second to avoid flooding the relay.
All room members render the same map state.

**Acceptance Criteria:**
- `geometry-update` contains room dimensions, both device positions, and wall confidence scores
- Broadcast throttled: no more than 2 messages/second
- All devices in room receive update within 100ms
- Stale geometry (solver hasn't run recently) indicated with a timestamp field

**Smoke Test:**
```typescript
// smoke/mdv-t17.test.ts
describe('Geometry broadcast', () => {
  it('throttles to 2 updates per second', async () => {
    const updates: number[] = [];
    peer.onGeometryUpdate = () => updates.push(Date.now());
    await broadcaster.runFor(2000);
    expect(updates.length).toBeLessThanOrEqual(5); // 2/s * 2s + margin
  });
});
```

---

## Epoch 3: Stereo TDOA + Distributed Sensing (Weeks 9–12)

### PRD 7.5: TDOA Angular Estimation

**Problem:** With clock-synchronized devices recording the same sweep, the time difference
of arrival at the two mics constrains the wall bearing angle. This converts the mapper
from distance-only to distance+angle, dramatically reducing the number of sweeps needed
for convergence.

### PRD 7.6: Non-Rectangular Room Support

**Problem:** The current solver assumes a rectangular room. Real rooms have alcoves, L-shapes,
and bay windows. The geometry model needs to represent arbitrary polygons.

### Requirements

| ID | Requirement | Priority |
|---|---|---|
| MDV-16 | TDOA computed from synchronized dual recordings | Must |
| MDV-17 | Angular bearing derived from TDOA: `bearing = arcsin(TDOA·c/baseline)` | Must |
| MDV-18 | Angular constraints integrated into 9-parameter solver | Must |
| MDV-19 | Rover/Base walking mode tracks rover position via direct-path + TDOA | Should |
| MDV-20 | IMU fusion with acoustic position via complementary filter | Should |
| MDV-21 | Room represented as arbitrary polygon (walls as oriented segments) | Should |
| MDV-22 | Polygonal room rendered on map with clipped coverage grid | Should |

### Epoch 3 Tickets

| ID | Title | Effort | Deps |
|---|---|---|---|
| MDV-T18 | Synchronized dual-recording (both devices record each sweep for TDOA) | L | T05–06 |
| MDV-T19 | TDOA computation (peak matching, bearing = arcsin(TDOA·c/baseline), uncertainty) | L | T18 |
| MDV-T20 | Angular constraints in solver (bearing residuals with arctan2 Jacobian) | L | T16–19 |
| MDV-T21 | Rover/Base walking mode (base stationary, tracks rover via direct-path + TDOA bearing) | L | T10–18 |
| MDV-T22 | Position fusion (acoustic base fix + IMU, complementary filter α=0.7) | L | T21 |
| MDV-T23 | Polygonal room model (walls as oriented segments, area via shoelace, fromRectangular() compat) | L | T20 |
| MDV-T24 | Polygonal room visualization (arbitrary polygon, clipped coverage grid) | M | T09–23 |
| MDV-T25 | End-to-end multi-device flow (pair → scan → fuse → display, disconnect recovery) | L | T10, T16–17 |

#### TICKET MDV-T18: Synchronized dual-recording
**Type:** Feature
**Points:** 8

**Description:**
Both devices record each sweep simultaneously (using the coordinated trigger from MDV-T06).
The direct-path arrival time at each recorder differs by `TDOA = |d1 − d2| / c`. Both
peak sets are tagged with device position and clock-corrected capture time.

**Acceptance Criteria:**
- Both devices open capture windows on same trigger
- Direct-path peak times stored with sub-millisecond resolution
- Peak pair (A, B) for the same reflection identified by proximity of delay times
- Works when one device is the emitter (direct path is near-zero on emitter side)

**Smoke Test:**
```typescript
// smoke/mdv-t18.test.ts
describe('Dual recording', () => {
  it('both devices record direct-path peak', async () => {
    const [peaksA, peaksB] = await session.dualRecord();
    const directA = peaksA.find(p => p.delayMs < 2);
    const directB = peaksB.find(p => p.delayMs < 2);
    expect(directA).toBeDefined();
    expect(directB).toBeDefined();
  });
});
```

---

#### TICKET MDV-T19: TDOA computation
**Type:** Feature
**Points:** 8

**Description:**
Match corresponding echo peaks from both recorders (same reflection, different arrival times).
Compute `TDOA = t_A − t_B` (clock-corrected). Derive bearing angle:
`bearing = arcsin(TDOA · c / baseline)`. Report uncertainty based on clock sync quality
and peak confidence.

**Acceptance Criteria:**
- Peak matching uses Hungarian algorithm or greedy nearest-neighbor by delay time
- TDOA resolution: 1 sample at 48kHz ≈ 0.02ms → ~7mm spatial resolution
- Bearing uncertainty propagated from clock sync uncertainty and peak confidence
- Occluded sweeps (MDV-T12) excluded from TDOA computation

**Smoke Test:**
```typescript
// smoke/mdv-t19.test.ts
describe('TDOA bearing', () => {
  it('computes correct bearing for known geometry', () => {
    const baseline = 2.0; // meters
    const tdoa = 0.001; // 1ms
    const c = 343;
    const bearing = TDOASolver.bearing(tdoa, baseline, c);
    expect(bearing).toBeCloseTo(Math.asin(tdoa * c / baseline), 3);
  });

  it('bearing uncertainty increases with poor clock sync', () => {
    const goodSync = TDOASolver.bearingWithUncertainty(0.001, 2.0, { clockUncertaintyMs: 0.1 });
    const poorSync = TDOASolver.bearingWithUncertainty(0.001, 2.0, { clockUncertaintyMs: 1.0 });
    expect(poorSync.uncertainty).toBeGreaterThan(goodSync.uncertainty);
  });
});
```

---

#### TICKET MDV-T20: Angular constraints in solver
**Type:** Feature
**Points:** 8

**Description:**
Add bearing residuals to the 9-parameter solver. Each TDOA observation contributes a
bearing constraint: the predicted angle from device positions to the wall must match the
measured bearing. Residual computed via `arctan2` Jacobian.

**Acceptance Criteria:**
- Bearing constraint implemented as a residual function in the solver
- Jacobian of `arctan2(dy, dx)` with respect to wall position computed analytically
- Solver convergence faster with angular constraints (fewer sweeps to same accuracy)
- Angular constraints weighted by bearing uncertainty from MDV-T19

**Smoke Test:**
```typescript
// smoke/mdv-t20.test.ts
describe('Angular solver constraints', () => {
  it('improves convergence with bearing data', () => {
    const obs = syntheticObservations(truth, 10); // sparse
    const withoutBearing = JointSolver.solve(obs, { useBearing: false });
    const withBearing = JointSolver.solve(obs, { useBearing: true });
    expect(withBearing.residual).toBeLessThan(withoutBearing.residual);
  });
});
```

---

#### TICKET MDV-T21: Rover/Base walking mode
**Type:** Feature
**Points:** 8

**Description:**
One device (Base) stays stationary and continuously emits. The other (Rover) walks the
room. At each Rover position, the direct-path distance to Base is computed from the
direct-path peak delay, and TDOA bearing gives the angle. Together, distance + bearing
triangulates the Rover's position relative to Base.

**Acceptance Criteria:**
- Base emits continuously at 1 sweep/second in walking mode
- Rover position estimated from direct-path delay + TDOA bearing at each sweep
- Position trail rendered on map as the Rover moves
- Minimum of 3 known Rover positions needed before wall estimation begins
- Walking mode togglable without re-pairing

**Smoke Test:**
```typescript
// smoke/mdv-t21.test.ts
describe('Walking mode', () => {
  it('estimates rover position from distance and bearing', () => {
    const base = { x: 0, y: 0 };
    const roverTrue = { x: 2, y: 1.5 };
    const distance = Math.hypot(2, 1.5);
    const bearing = Math.atan2(1.5, 2);
    const estimated = RoverTracker.estimate(base, distance, bearing);
    expect(Math.abs(estimated.x - roverTrue.x)).toBeLessThan(0.1);
    expect(Math.abs(estimated.y - roverTrue.y)).toBeLessThan(0.1);
  });
});
```

---

#### TICKET MDV-T22: IMU/acoustic position fusion
**Type:** Feature
**Points:** 8

**Description:**
Fuse acoustic position estimates (noisy, low-rate) with IMU dead-reckoning (smooth,
high-rate but drifting) using a complementary filter: `pos = α·acoustic + (1−α)·imu`
with α=0.7. Reduces jitter in the position trail during walking mode.

**Acceptance Criteria:**
- IMU data read from device motion sensors (accelerometer + gyro)
- Complementary filter α configurable (default 0.7)
- Position trail smoother with fusion than without (RMS jitter < 5cm)
- Fusion disabled gracefully if IMU unavailable

**Smoke Test:**
```typescript
// smoke/mdv-t22.test.ts
describe('IMU fusion', () => {
  it('reduces position jitter', () => {
    const acousticPositions = noisyPositions(true_path, sigma=0.2);
    const imuPositions = driftingPositions(true_path, drift=0.01);
    const fused = ComplementaryFilter.fuse(acousticPositions, imuPositions, 0.7);
    expect(rmsError(fused, true_path)).toBeLessThan(rmsError(acousticPositions, true_path));
  });
});
```

---

#### TICKET MDV-T23: Polygonal room model
**Type:** Feature
**Points:** 8

**Description:**
Replace the rectangular room model `[Lx, Ly, Lz]` with an arbitrary polygon: an ordered
list of wall segments `[{start, end, normal}]`. Area computed via shoelace formula.
`fromRectangular(Lx, Ly)` factory method keeps existing single-device results compatible.

**Acceptance Criteria:**
- `PolygonalRoom` class with ordered wall segments
- Area computed via shoelace formula; validated against known rectangles
- `fromRectangular(Lx, Ly, Lz)` creates a 4-wall polygon compatible with existing solver output
- Wall segments used as reflection surfaces in elliptical constraint computation

**Smoke Test:**
```typescript
// smoke/mdv-t23.test.ts
describe('Polygonal room model', () => {
  it('computes correct area for rectangle', () => {
    const room = PolygonalRoom.fromRectangular(5, 4, 2.5);
    expect(room.floorArea()).toBeCloseTo(20, 2);
  });

  it('represents L-shaped room', () => {
    const walls = [
      { start: [0,0], end: [4,0] },
      { start: [4,0], end: [4,2] },
      { start: [4,2], end: [2,2] },
      { start: [2,2], end: [2,4] },
      { start: [2,4], end: [0,4] },
      { start: [0,4], end: [0,0] },
    ];
    const room = new PolygonalRoom(walls, 2.5);
    expect(room.wallCount()).toBe(6);
    expect(room.floorArea()).toBeCloseTo(12, 1);
  });
});
```

---

#### TICKET MDV-T24: Polygonal room visualization
**Type:** Feature
**Points:** 5

**Description:**
Render the polygonal room on the map canvas. Draw each wall segment. Clip the
coverage-quality grid to the polygon interior (discard cells outside the room boundary).
Extend the existing rectangular map renderer — don't replace it.

**Acceptance Criteria:**
- Polygon outline rendered correctly for both rectangular and non-rectangular rooms
- Coverage grid cells outside polygon boundary not rendered
- `fromRectangular` rooms render identically to current output
- Canvas updates within 50ms of receiving new polygon geometry

**Smoke Test:**
```typescript
// smoke/mdv-t24.test.ts
describe('Polygonal visualization', () => {
  it('renders same as rectangular for box rooms', () => {
    const rect = RoomRenderer.renderRectangular(5, 4);
    const poly = RoomRenderer.renderPolygon(PolygonalRoom.fromRectangular(5, 4, 2.5));
    expect(pixelDiff(rect, poly)).toBeLessThan(10); // near-identical
  });
});
```

---

#### TICKET MDV-T25: End-to-end multi-device integration
**Type:** Integration
**Points:** 8

**Description:**
Validate the complete multi-device flow from pairing through room display. Covers:
pair → role assign → clock sync → scan (role alternation) → geometry fusion → map display.
Also validates disconnect recovery: if the peer drops, the session degrades to single-device
mode without crashing.

**Acceptance Criteria:**
- Full flow completes without manual intervention in under 3 minutes
- Disconnect at any stage: session degrades gracefully, user notified, can reconnect
- Reconnected device resumes session (room code still valid for 10 minutes)
- Fused room estimate within 10% of tape-measured dimensions on LAN test

**Smoke Test:**
```typescript
// smoke/mdv-t25.test.ts
describe('End-to-end multi-device', () => {
  it('completes pair→scan→fuse flow', async () => {
    const session = await MultiDeviceSession.create();
    await session.pair('9999');
    await session.assignRoles();
    await session.syncClocks();
    await session.runAlternation(3);
    const geometry = session.getGeometry();
    expect(geometry.Lx).toBeGreaterThan(0);
    expect(geometry.confidence).toBeGreaterThan(0.7);
  }, 180_000);

  it('degrades gracefully on peer disconnect', async () => {
    const session = await MultiDeviceSession.create();
    await session.pair('8888');
    session.simulatePeerDisconnect();
    await delay(500);
    expect(session.mode).toBe('single-device');
    expect(session.isRunning()).toBe(true);
  });
});
```

---

## Summary

**25 tickets** across 3 epochs — 5S + 9M + 11L.

| Epoch | Weeks | PRDs | Tickets | Goal |
|---|---|---|---|---|
| 1: Device Coordination | 1–4 | 7.1, 7.2 | T01–T09 | Two devices paired, sweeping, and showing fused map |
| 2: Robust Measurement | 5–8 | 7.3, 7.4 | T10–T17 | Role alternation, quality gating, 9-param solver |
| 3: Stereo TDOA | 9–12 | 7.5, 7.6 | T18–T25 | Bearing estimation, walking mode, polygonal rooms |

**Verification milestones:**
- Epoch 1: Two Chrome tabs on same machine — pair via code, one emits, other shows echo peaks
- Epoch 2: Phone + laptop on LAN — role alternation produces 2× echo data, fused geometry matches tape-measured room within 10%
- Epoch 3: Walk phone around room while laptop stays fixed — position trail matches walked path, non-rectangular room detected
