#include "lipSyncEngineLib.h"
#include "core/Phone.h"
#include "tools/textFiles.h"
#include "animation/mouthAnimation.h"

using boost::optional;
using std::string;

JoiningContinuousTimeline<Shape> animateAudioClip(
	const AudioClip& audioClip,
	const optional<string>& dialog,
	const Recognizer& recognizer,
	const ShapeSet& targetShapeSet,
	int maxThreadCount,
	ProgressSink& progressSink)
{
	const BoundedTimeline<Phone> phones =
		recognizer.recognizePhones(audioClip, dialog, maxThreadCount, progressSink);
	JoiningContinuousTimeline<Shape> result = animate(phones, targetShapeSet);
	return result;
}

// animateWaveFile removed - not needed for WASM PCM→JSON workflow
