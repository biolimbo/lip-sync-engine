#pragma once

#include "tools/EnumConverter.h"
#include "Sink.h"
#include "Level.h"

namespace logging {

	bool addSink(std::shared_ptr<Sink> sink);

	bool removeSink(std::shared_ptr<Sink> sink);

	void log(const Entry& entry);

	void log(Level level, const std::string& message);

	// Messages below this level are dropped before they are formatted.
	// Default Trace (everything). The WASM bridge sets Info, matching its sink.
	void setMinLevel(Level level);

	bool isEnabled(Level level);

	template<typename... Args>
	void logFormat(Level level, fmt::CStringRef format, const Args&... args) {
		if (!isEnabled(level)) return;
		log(level, fmt::format(format, args...));
	}

#define LOG_WITH_LEVEL(levelName, levelEnum) \
	inline void levelName(const std::string& message) { \
		log(Level::levelEnum, message); \
	} \
	template <typename... Args> \
	void levelName ## Format(fmt::CStringRef format, const Args&... args) { \
		logFormat(Level::levelEnum, format, args...); \
	}

	LOG_WITH_LEVEL(trace, Trace)
	LOG_WITH_LEVEL(debug, Debug)
	LOG_WITH_LEVEL(info, Info)
	LOG_WITH_LEVEL(warn, Warn)
	LOG_WITH_LEVEL(error, Error)
	LOG_WITH_LEVEL(fatal, Fatal)
}
