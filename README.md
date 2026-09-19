# Beacon

Beacon is a single-file browser app that maps a room with sound. It plays an exponential sine sweep from a phone's speaker, records the reflections through the microphone, deconvolves an impulse response, and turns the echo peaks into wall distances and a floor plan. A small Node relay lets two devices split the emitter and recorder roles.

## Status

Prototype, paused since April 2026. The code has four modes: a single-device sweep, a walking mode that tracks how echo delays change as the phone moves using the IMU, a passive mode that estimates room dimensions from resonant modes in ambient sound, and a two-device mode that pairs phones through the relay. The sweep pipeline runs end to end on a phone. I never validated the distances against a tape measure. The epic in `docs/epics/07-MULTI-DEVICE-MAPPING.md` records why single-device results are unreliable and how the two-device version should work.

## Run it

Serve the directory over HTTP so the browser treats the page as a secure origin and allows microphone access.

```
python3 -m http.server 5175
```

Open `http://localhost:5175/acoustic-mapper.html` and allow the microphone. React, Babel, and Tailwind load from CDNs, so the page needs a network connection.

For two devices, run the relay on a laptop, then enter the laptop's LAN address and a shared room code on each phone.

```
cd hypervisor && npm install && npm start
```

## The main decision

Everything is one HTML file with the signal processing written by hand. There is no build step and no audio library. The FFT, sweep generation, inverse filter, cross-correlation, and room solver are plain functions at the top of the file, and React and Tailwind come from CDNs. I chose that because the target device is a phone, and the fastest loop for an acoustics experiment is editing a file and reloading it there. It cost testability. There are no unit tests for the math, and a 4,000-line file is hard to navigate. The finding that mattered was physical rather than structural. A single phone cannot separate its own speaker from its microphone well enough to see early reflections, and iOS echo cancellation removes the sweep before it reaches the mic. That is why the plan moves to two devices.
