#pragma once

#include <cstdint>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Initialize the LipSyncEngine WASM module.
 * Must be called before any other functions.
 *
 * @param models_path Path to models directory in Emscripten virtual FS (usually "/models")
 * @return 0 on success, non-zero on error
 */
int lipsyncengine_init(const char* models_path);

/**
 * Analyze PCM16 audio data and generate lip-sync-engine animation as JSON.
 *
 * @param pcm16 Pointer to PCM16 audio data (int16_t array)
 * @param sample_count Number of samples in pcm16 array
 * @param sample_rate Sample rate in Hz (e.g., 16000, 22050, 44100, 48000)
 * @param dialog_text Optional dialog text for improved recognition (can be NULL or empty string)
 * @return JSON string with animation data, or NULL on error.
 *         Caller must free the returned string using lipsyncengine_free()
 */
const char* lipsyncengine_analyze_pcm16(
	const int16_t* pcm16,
	int32_t sample_count,
	int32_t sample_rate,
	const char* dialog_text
);

/**
 * Free memory allocated by lipsyncengine_analyze_pcm16.
 *
 * @param ptr Pointer to free (returned from lipsyncengine_analyze_pcm16)
 */
void lipsyncengine_free(const char* ptr);

/**
 * Get the last error message.
 *
 * @return Error message string, or NULL if no error.
 *         Do NOT free the returned string.
 */
const char* lipsyncengine_get_last_error();

#ifdef __cplusplus
}
#endif
