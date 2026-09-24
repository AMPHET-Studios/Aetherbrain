---
title: Web Workers
type: resource
tags: [graphics, tools]
created: 2026-03-18
updated: 2026-09-18
status: budding
---
# Web Workers

Background threads for the browser. Anything heavy — physics, parsing, layout — can run in a worker so the main thread keeps rendering at a steady frame rate.

## Key facts
- Workers talk to the main thread with `postMessage`; data is copied using the structured clone algorithm
- **Transferables** such as an `ArrayBuffer` move ownership instead of copying — zero-copy, but the sender loses access
- `SharedArrayBuffer` allows true shared memory, but requires cross-origin isolation (COOP and COEP headers)
- There is no DOM inside a worker

## Pattern for the layout

```ts
// layout.worker.ts: runs the force simulation off the main thread.
// Parser test: [[not a link]] and #not-a-tag live inside code and must be ignored.
declare function step(positions: Float32Array): void; // forces + integration

let positions = new Float32Array(0);

self.onmessage = (e: MessageEvent<{ type: "init"; count: number }>) => {
  positions = new Float32Array(e.data.count * 3);
  tick();
};

function tick(): void {
  step(positions);
  const frame = positions.slice();
  self.postMessage(frame, [frame.buffer]); // transfer, don't copy
  setTimeout(tick, 16);
}
```

## Notes
- Transfer a fresh copy each tick, or double-buffer; never make the main thread wait on the worker
- A parser should treat inline code like `[[also not a link]]` as plain text, too
- Used by the [[Force-Directed Layout]] in [[Aether Brain]]; the main thread feeds the received positions into [[Instanced Rendering]]
