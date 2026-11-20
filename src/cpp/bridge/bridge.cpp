#include "bridge.h"
#include "audio_utils.h"
#include "lib/lipSyncEngineLib.h"
#include "recognition/PocketSphinxRecognizer.h"
#include "recognition/PhoneticRecognizer.h"
#include "exporters/JsonExporter.h"
#include "animation/targetShapeSet.h"
#include "tools/progress.h"
#include "logging/logging.h"
#include "logging/sinks.h"
#include "logging/formatters.h"
#include "core/Shape.h"
#include <compat/boost_compat.h>
#include <sstream>
#include <string>
#include <memory>
#include <cstring>
#include <stdexcept>

// Custom sink to filter out munmap errors
class MunmapFilterSink : public logging::Sink {
public:
	MunmapFilterSink(std::shared_ptr<logging::Sink> innerSink) : innerSink(innerSink) {}

	void receive(const logging::Entry& entry) override {
		// Filter out munmap errors from mmio.c
		if (entry.message.find("Failed to unmap") != std::string::npos) {
			return; // Suppress this message
		}
		// Pass other messages through
		innerSink->receive(entry);
	}

private:
	std::shared_ptr<logging::Sink> innerSink;
};

// Global state
static std::string g_models_path;
static std::string g_last_error;
static bool g_initialized = false;

// Decoder reuse optimization (Phase 0)
static std::unique_ptr<Recognizer> g_recognizer;
static int g_recognizer_kind = 0; // 0 = PocketSphinx words, 1 = phonetic
// Target mouth shapes: basic A-F plus extended G, H, X (all nine, Rhubarb's
// default since 2.0.0). lipsyncengine_set_extended_shapes("") = A-F only.
static ShapeSet allShapes() {
	ShapeSet result = ShapeConverter::get().getBasicShapes();
	result.insert(Shape::G);
	result.insert(Shape::H);
	result.insert(Shape::X);
	return result;
}
static ShapeSet g_target_shapes = allShapes();
static std::string g_cached_dialog_text;

// Internal error handling
static void set_error(const std::string& error) {
	g_last_error = error;
}

static void clear_error() {
	g_last_error.clear();
}

// Initialize LipSyncEngine WASM module
extern "C" int lipsyncengine_init(const char* models_path) {
	try {
		clear_error();

		if (!models_path || std::strlen(models_path) == 0) {
			set_error("models_path cannot be NULL or empty");
			return -1;
		}

		g_models_path = models_path;

		// Phase 0: Create recognizer once for reuse
		if (g_recognizer_kind == 1) g_recognizer = std::make_unique<PhoneticRecognizer>();
		else g_recognizer = std::make_unique<PocketSphinxRecognizer>();
		g_cached_dialog_text = "";

		// Set up logging with custom filter to suppress munmap errors (once)
		static bool sinkAdded = false;
		if (!sinkAdded) {
			auto formatter = std::make_shared<logging::SimpleConsoleFormatter>();
			auto stderrSink = std::make_shared<logging::StdErrSink>(formatter);
			auto munmapFilter = std::make_shared<MunmapFilterSink>(stderrSink);
			auto levelFilter = std::make_shared<logging::LevelFilter>(munmapFilter, logging::Level::Info);
			logging::addSink(levelFilter);
			// Drop lower-level messages before they are formatted
			logging::setMinLevel(logging::Level::Info);
			sinkAdded = true;
		}

		g_initialized = true;

		return 0;
	} catch (const std::exception& e) {
		set_error(std::string("Initialization error: ") + e.what());
		return -1;
	} catch (...) {
		set_error("Unknown initialization error");
		return -1;
	}
}

// Build the default decoder ahead of the first analysis
extern "C" int lipsyncengine_prewarm() {
	try {
		clear_error();
		if (!g_initialized) {
			set_error("Module not initialized. Call lipsyncengine_init() first");
			return -1;
		}
		if (g_recognizer_kind == 1) prewarmPhoneticDecoder();
		else prewarmPocketSphinxDecoder();
		return 0;
	} catch (const std::exception& e) {
		set_error(std::string("Prewarm error: ") + e.what());
		return -1;
	} catch (...) {
		set_error("Unknown prewarm error");
		return -1;
	}
}

// Select the recognizer: 0 = PocketSphinx word recognition (default),
// 1 = phonetic (no word language model; ignores dialog text)
extern "C" int lipsyncengine_set_recognizer(int kind) {
	clear_error();
	if (kind != 0 && kind != 1) {
		set_error("Unknown recognizer");
		return -1;
	}
	if (kind == g_recognizer_kind && g_recognizer) return 0;
	g_recognizer_kind = kind;
	if (kind == 1) {
		g_recognizer = std::make_unique<PhoneticRecognizer>();
		releasePocketSphinxDecoders();
	} else {
		g_recognizer = std::make_unique<PocketSphinxRecognizer>();
		releasePhoneticDecoder();
	}
	return 0;
}

// Choose Rhubarb's extended mouth shapes on top of A-F: any combination of
// "G" (F/V), "H" (L) and "X" (idle), like Rhubarb's --extendedShapes option.
// Default (never called) = "GHX". "" or NULL = basic shapes A-F only (1.x output).
extern "C" int lipsyncengine_set_extended_shapes(const char* shapes) {
	clear_error();
	ShapeSet result = ShapeConverter::get().getBasicShapes();
	if (shapes) {
		for (const char* c = shapes; *c; ++c) {
			if (*c == 'G' || *c == 'g') result.insert(Shape::G);
			else if (*c == 'H' || *c == 'h') result.insert(Shape::H);
			else if (*c == 'X' || *c == 'x') result.insert(Shape::X);
			else {
				set_error(std::string("Unknown extended shape '") + *c + "'. Use any of G, H, X.");
				return -1;
			}
		}
	}
	g_target_shapes = result;
	return 0;
}

// Analyze PCM16 audio and generate JSON lip-sync-engine data
extern "C" const char* lipsyncengine_analyze_pcm16(
	const int16_t* pcm16,
	int32_t sample_count,
	int32_t sample_rate,
	const char* dialog_text
) {
	try {
		clear_error();

		if (!g_initialized || !g_recognizer) {
			set_error("Module not initialized. Call lipsyncengine_init() first");
			return nullptr;
		}

		if (!pcm16) {
			set_error("pcm16 cannot be NULL");
			return nullptr;
		}

		if (sample_count <= 0) {
			set_error("sample_count must be positive");
			return nullptr;
		}

		if (sample_rate <= 0) {
			set_error("sample_rate must be positive");
			return nullptr;
		}

		// Create AudioClip from PCM buffer (NO file I/O)
		auto audio_clip = createAudioClipFromPCM16(pcm16, sample_count, sample_rate);

		// Phase 0: Check if dialog text changed (for language model caching)
		std::string current_dialog = (dialog_text && std::strlen(dialog_text) > 0)
			? std::string(dialog_text)
			: "";

		// Note: Full language model caching will be added in Phase 0.4
		// For now, we rely on PocketSphinx's internal caching
		// Update the cached dialog text for future optimizations
		g_cached_dialog_text = current_dialog;

		// Parse dialog text (optional)
		boost::optional<std::string> dialog;
		if (!current_dialog.empty()) {
			dialog = current_dialog;
		}

		// The recognizer keeps its PocketSphinx decoders cached between calls
		// (see PocketSphinxRecognizer.cpp), so only the first call builds one.

		// Target shapes: basic A-F plus any chosen extended shapes
		const ShapeSet target_shapes = g_target_shapes;

		// Create progress sink (no-op for WASM)
		NullProgressSink progress_sink;

		// Animate (single-threaded for WASM)
		const int max_thread_count = 1;
		auto animation = animateAudioClip(
			*audio_clip,
			dialog,
			*g_recognizer,  // Phase 0: Use global recognizer for reuse
			target_shapes,
			max_thread_count,
			progress_sink
		);

		// Export to JSON (ONLY format supported)
		std::ostringstream json_stream;

		// Create ExporterInput with memory identifier (NOT a filesystem path)
		ExporterInput exporter_input(
			"memory://pcm",  // Memory identifier, NOT a file path
			animation,
			target_shapes
		);

		JsonExporter exporter;
		exporter.exportAnimation(exporter_input, json_stream);

		// Convert to C string
		std::string json = json_stream.str();
		char* result = static_cast<char*>(malloc(json.size() + 1));
		if (!result) {
			set_error("Memory allocation failed");
			return nullptr;
		}

		std::memcpy(result, json.data(), json.size());
		result[json.size()] = '\0';

		return result;

	} catch (const std::exception& e) {
		set_error(std::string("Analysis error: ") + e.what());
		return nullptr;
	} catch (...) {
		set_error("Unknown analysis error");
		return nullptr;
	}
}

// Free memory allocated by lipsyncengine_analyze_pcm16
extern "C" void lipsyncengine_free(const char* ptr) {
	if (ptr) {
		free(const_cast<char*>(ptr));
	}
}

// Get last error message
extern "C" const char* lipsyncengine_get_last_error() {
	if (g_last_error.empty()) {
		return nullptr;
	}
	return g_last_error.c_str();
}

// Phase 0: Cleanup function to free decoder resources
extern "C" void lipsyncengine_cleanup() {
	releasePocketSphinxDecoders();
	releasePhoneticDecoder();
	g_recognizer.reset();
	g_cached_dialog_text.clear();
	g_initialized = false;
}
