#include "bridge.h"
#include "audio_utils.h"
#include "lib/lipSyncEngineLib.h"
#include "recognition/PocketSphinxRecognizer.h"
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
		g_initialized = true;

		// Set up logging with custom filter to suppress munmap errors
		auto formatter = std::make_shared<logging::SimpleConsoleFormatter>();
		auto stderrSink = std::make_shared<logging::StdErrSink>(formatter);
		auto munmapFilter = std::make_shared<MunmapFilterSink>(stderrSink);
		auto levelFilter = std::make_shared<logging::LevelFilter>(munmapFilter, logging::Level::Info);
		logging::addSink(levelFilter);

		return 0;
	} catch (const std::exception& e) {
		set_error(std::string("Initialization error: ") + e.what());
		return -1;
	} catch (...) {
		set_error("Unknown initialization error");
		return -1;
	}
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

		if (!g_initialized) {
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

		// Parse dialog text (optional)
		boost::optional<std::string> dialog;
		if (dialog_text && std::strlen(dialog_text) > 0) {
			dialog = std::string(dialog_text);
		}

		// Create recognizer
		PocketSphinxRecognizer recognizer;

		// Get target shape set (using basic shapes only for now)
		ShapeSet target_shapes = ShapeConverter::get().getBasicShapes();

		// Create progress sink (no-op for WASM)
		NullProgressSink progress_sink;

		// Animate (single-threaded for WASM)
		const int max_thread_count = 1;
		auto animation = animateAudioClip(
			*audio_clip,
			dialog,
			recognizer,
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
