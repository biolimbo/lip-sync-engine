#pragma once

#include <string>
#include <filesystem>
#include <ctime>
#include <compat/wasm_platform.h>

// Platform tools for WASM
// Uses wasm_platform.h for actual implementation

inline std::filesystem::path getBinDirectory() {
	return std::filesystem::path(platform::getBinDirectory());
}

inline std::filesystem::path getBinPath() {
	return std::filesystem::path(platform::getBinPath());
}

inline std::string getTempFilePath() {
	return platform::getTempFilePath();
}

inline std::tm getLocalTime(const std::time_t& time) {
	std::tm timeInfo {};
#if (__unix || __linux || __APPLE__ || __EMSCRIPTEN__)
	localtime_r(&time, &timeInfo);
#else
	localtime_s(&timeInfo, &time);
#endif
	return timeInfo;
}
