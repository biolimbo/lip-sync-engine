// Stubs for flite functions excluded from WASM build
// These functions are part of audio output which is not needed

void val_delete_audio_streaming_info(void* val) {
    // Stub - audio streaming not used in WASM
    (void)val;
}
