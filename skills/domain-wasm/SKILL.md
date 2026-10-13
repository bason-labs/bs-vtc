---
name: domain-wasm
description: "WebAssembly domain pack (VTC spec 5.2a). Load when the repository or the specification shows WebAssembly modules (wasm-bindgen, Emscripten, WASI targets, *.wasm builds); adds the domain's rules to the Engineer and the reviewers. Cite rule ids in findings."
---

# WebAssembly domain pack

Load when: WebAssembly modules (wasm-bindgen, Emscripten, WASI targets, *.wasm builds).

## Rules

- **WASM-1** Benchmark against the real baseline before porting; compute-heavy kernels win, glue
  code usually loses.
- **WASM-2** Design around the boundary: batch work inside the module and cross with large
  buffers, not per-element calls.
- **WASM-3** Strings and objects are copied across the boundary; pass handles or shared buffers.
- **WASM-4** Manage linear memory deliberately; it grows but does not shrink in a running
  instance.
- **WASM-5** Grant only the WASI capabilities a module needs.
- **WASM-6** Ship size-optimised modules with streaming compilation.
- **WASM-7** Feature-detect SIMD, threads and other optional features, with a working fallback.

Sources: forked from msitarzewski/agency-agents (MIT, see NOTICE): engineering-webassembly-
engineer.md.
