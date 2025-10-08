#include "audio_utils.h"
#include <memory>
#include <algorithm>

// In-memory AudioClip implementation for WASM
// NO file I/O - operates entirely on memory buffers
class MemoryAudioClip : public AudioClip {
public:
	MemoryAudioClip(const int16_t* pcm16, size_t sample_count, int sample_rate)
		: samples_(std::make_shared<std::vector<int16_t>>(pcm16, pcm16 + sample_count)),
		  sample_rate_(sample_rate)
	{
		if (sample_rate <= 0) {
			throw std::invalid_argument("Sample rate must be positive");
		}
		if (sample_count == 0) {
			throw std::invalid_argument("Sample count must be greater than zero");
		}
	}

	std::unique_ptr<AudioClip> clone() const override {
		return std::make_unique<MemoryAudioClip>(samples_->data(), samples_->size(), sample_rate_);
	}

	SampleReader createUnsafeSampleReader() const override {
		auto data_ptr = samples_;
		return [data_ptr](size_type index) -> float {
			// Convert int16 [-32768, 32767] to float [-1.0, 1.0]
			const int16_t sample = (*data_ptr)[index];
			return static_cast<float>(sample) / 32768.0f;
		};
	}

	int getSampleRate() const override {
		return sample_rate_;
	}

	size_type size() const override {
		return samples_->size();
	}

private:
	std::shared_ptr<std::vector<int16_t>> samples_;
	int sample_rate_;
};

std::unique_ptr<AudioClip> createAudioClipFromPCM16(
	const int16_t* pcm16,
	size_t sample_count,
	int sample_rate
) {
	return std::make_unique<MemoryAudioClip>(pcm16, sample_count, sample_rate);
}
