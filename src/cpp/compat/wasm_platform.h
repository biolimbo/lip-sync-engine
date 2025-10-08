#pragma once

#include <string>
#include <random>
#include <sstream>
#include <iomanip>

// Platform compatibility layer for WASM
// Provides stubs for platform-specific functionality

namespace platform {

// Generate simple UUID for WASM environment
inline std::string generateUuid() {
	static std::random_device rd;
	static std::mt19937 gen(rd());
	static std::uniform_int_distribution<uint32_t> dis(0, 0xFFFFFFFF);

	std::stringstream ss;
	ss << std::hex << std::setfill('0');

	// Generate UUID format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
	ss << std::setw(8) << dis(gen) << "-";
	ss << std::setw(4) << (dis(gen) & 0xFFFF) << "-";
	ss << std::setw(4) << ((dis(gen) & 0x0FFF) | 0x4000) << "-";
	ss << std::setw(4) << ((dis(gen) & 0x3FFF) | 0x8000) << "-";
	ss << std::setw(8) << dis(gen);
	ss << std::setw(4) << (dis(gen) & 0xFFFF);

	return ss.str();
}

// Get binary path (WASM virtual filesystem)
inline std::string getBinPath() {
	return "/wasm/lip-sync.wasm";
}

// Get binary directory (WASM virtual filesystem)
inline std::string getBinDirectory() {
	return "/wasm";
}

// Get resources path (models directory in WASM virtual filesystem)
inline std::string getResourcesPath() {
	return "/models";
}

// Get temp file path (WASM doesn't need temp files for PCM→JSON workflow)
inline std::string getTempFilePath() {
	return "/tmp/" + generateUuid();
}

} // namespace platform
