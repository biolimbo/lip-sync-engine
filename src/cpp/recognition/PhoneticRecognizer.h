#pragma once

#include "Recognizer.h"
#include "pocketSphinxTools.h"

// Phone-level recognition without words (Rhubarb's "phonetic" recognizer).
// Needs no word language model or pronunciation dictionary, so it starts
// faster and uses less memory. Dialog text is ignored.
class PhoneticRecognizer : public Recognizer {
public:
	BoundedTimeline<Phone> recognizePhones(
		const AudioClip& inputAudioClip,
		boost::optional<std::string> dialog,
		int maxThreadCount,
		ProgressSink& progressSink
	) const override;
};

// Builds the phonetic decoder ahead of the first analysis.
void prewarmPhoneticDecoder();

// Frees the cached phonetic decoder.
void releasePhoneticDecoder();
