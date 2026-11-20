// Port of Rhubarb Lip Sync's PhoneticRecognizer, with the decoder cached
// between calls like PocketSphinxRecognizer.
#include "PhoneticRecognizer.h"
#include "time/Timeline.h"
#include "audio/AudioSegment.h"
#include "audio/SampleRateConverter.h"
#include "audio/processing.h"
#include "time/timedLogging.h"
#include <mutex>

extern "C" {
#include <sphinxbase/genrand.h>
#include <pocketsphinx_internal.h>
}

using std::runtime_error;
using std::unique_ptr;
using std::string;
using std::vector;
using boost::optional;

static lambda_unique_ptr<ps_decoder_t> createPhoneticDecoder() {
	lambda_unique_ptr<cmd_ln_t> config(
		cmd_ln_init(
			nullptr, ps_args(), true,
			// Set acoustic model
			"-hmm", (getSphinxModelDirectory() / "acoustic-model").u8string().c_str(),
			// Set phonetic language model
			"-allphone", (getSphinxModelDirectory() / "en-us-phone.lm.bin").u8string().c_str(),
			"-allphone_ci", "yes",
			// Set language model probability weight.
			// Low values (<= 0.4) can lead to fluttering animation.
			// High values (>= 1.0) can lead to imprecise or freezing animation.
			"-lw", "0.8",
			// Add noise against zero silence
			"-dither", "yes",
			// Disable VAD -- we're doing that ourselves
			"-remove_silence", "no",
			// Perform per-utterance cepstral mean normalization
			"-cmn", "batch",
			nullptr),
		[](cmd_ln_t* config) { cmd_ln_free_r(config); });
	if (!config) throw runtime_error("Error creating configuration.");

	lambda_unique_ptr<ps_decoder_t> decoder(
		ps_init(config.get()),
		[](ps_decoder_t* recognizer) { ps_free(recognizer); });
	if (!decoder) throw runtime_error("Error creating speech decoder.");

	return decoder;
}

namespace {
	std::mutex& cacheMutex() {
		static std::mutex mutex;
		return mutex;
	}
	std::shared_ptr<ps_decoder_t>& cachedDecoder() {
		static std::shared_ptr<ps_decoder_t> decoder;
		return decoder;
	}
}

static lambda_unique_ptr<ps_decoder_t> acquirePhoneticDecoder(optional<string> dialog) {
	UNUSED(dialog);
	std::shared_ptr<ps_decoder_t> decoder;
	{
		std::lock_guard<std::mutex> lock(cacheMutex());
		if (!cachedDecoder()) {
			auto created = createPhoneticDecoder();
			cachedDecoder() = std::shared_ptr<ps_decoder_t>(
				created.release(), [](ps_decoder_t* d) { ps_free(d); });
		}
		decoder = cachedDecoder();
	}
	// Same output as a freshly created decoder (see PocketSphinxRecognizer.cpp)
	s3_rand_seed(cmd_ln_int32_r(decoder->config, "-seed"));
	return lambda_unique_ptr<ps_decoder_t>(decoder.get(), [decoder](ps_decoder_t*) {});
}

void prewarmPhoneticDecoder() {
	redirectPocketSphinxOutput();
	acquirePhoneticDecoder(boost::none);
}

void releasePhoneticDecoder() {
	std::lock_guard<std::mutex> lock(cacheMutex());
	cachedDecoder().reset();
}

static Timeline<Phone> utteranceToPhones(
	const AudioClip& audioClip,
	TimeRange utteranceTimeRange,
	ps_decoder_t& decoder,
	ProgressSink& utteranceProgressSink
) {
	// Pad time range to give PocketSphinx some breathing room
	TimeRange paddedTimeRange = utteranceTimeRange;
	const centiseconds padding(3);
	paddedTimeRange.grow(padding);
	paddedTimeRange.trim(audioClip.getTruncatedRange());

	const unique_ptr<AudioClip> clipSegment = audioClip.clone()
		| segment(paddedTimeRange)
		| resample(sphinxSampleRate);
	const auto audioBuffer = copyTo16bitBuffer(*clipSegment);

	// Detect phones (returned as words)
	BoundedTimeline<string> phoneStrings = recognizeWords(audioBuffer, decoder);
	phoneStrings.shift(paddedTimeRange.getStart());
	Timeline<Phone> utterancePhones;
	for (const auto& timedPhoneString : phoneStrings) {
		Phone phone = PhoneConverter::get().parse(timedPhoneString.getValue());
		if (phone == Phone::AH && timedPhoneString.getDuration() < 6_cs) {
			// Heuristic: < 6_cs is schwa. PocketSphinx doesn't differentiate.
			phone = Phone::Schwa;
		}
		utterancePhones.set(timedPhoneString.getTimeRange(), phone);
	}

	// Log raw phones
	for (const auto& timedPhone : utterancePhones) {
		logTimedEvent("rawPhone", timedPhone);
	}

	// Guess positions of noise sounds
	JoiningTimeline<void> noiseSounds = getNoiseSounds(utteranceTimeRange, utterancePhones);
	for (const auto& noiseSound : noiseSounds) {
		utterancePhones.set(noiseSound.getTimeRange(), Phone::Noise);
	}

	// Log phones
	for (const auto& timedPhone : utterancePhones) {
		logTimedEvent("phone", timedPhone);
	}

	utteranceProgressSink.reportProgress(1.0);

	return utterancePhones;
}

BoundedTimeline<Phone> PhoneticRecognizer::recognizePhones(
	const AudioClip& inputAudioClip,
	optional<string> dialog,
	int maxThreadCount,
	ProgressSink& progressSink
) const {
	return ::recognizePhones(
		inputAudioClip, dialog, &acquirePhoneticDecoder, &utteranceToPhones, maxThreadCount, progressSink);
}
