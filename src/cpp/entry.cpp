// Entry point for LipSync WASM module
// Emscripten will generate the WASM module from the C API in bridge.h
// No main() function needed - the bridge functions are exported directly

#include "bridge/bridge.h"

// This file serves as a compilation unit entry point.
// The actual entry points are the extern "C" functions in bridge.cpp:
// - lipsync_init()
// - lipsync_analyze_pcm16()
// - lipsync_free()
// - lipsync_get_last_error()
