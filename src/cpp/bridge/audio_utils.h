#pragma once

#include <memory>
#include <vector>
#include <cstdint>
#include "audio/AudioClip.h"

/**
 * Create an AudioClip from in-memory PCM16 data.
 * NO file I/O - pure memory operation.
 *
 * @param pcm16 Pointer to PCM16 samples
 * @param sample_count Number of samples
 * @param sample_rate Sample rate in Hz
 * @return Unique pointer to AudioClip
 */
std::unique_ptr<AudioClip> createAudioClipFromPCM16(
	const int16_t* pcm16,
	size_t sample_count,
	int sample_rate
);
