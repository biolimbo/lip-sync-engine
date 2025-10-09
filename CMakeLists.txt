cmake_minimum_required(VERSION 3.13)
message(STATUS "===== LOADING LIPSYNCENGINE-WASM CMakeLists.txt =====")
project(lipsyncengine-wasm)

# Require C++17
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Emscripten-specific settings
if(EMSCRIPTEN)
	set(CMAKE_EXECUTABLE_SUFFIX ".js")
endif()

# Include directories
include_directories(
	${CMAKE_SOURCE_DIR}/src/cpp
	${CMAKE_SOURCE_DIR}/src/cpp/compat
	${CMAKE_SOURCE_DIR}/lib/gsl/include
	${CMAKE_SOURCE_DIR}/lib/utfcpp-2.3.5/source
	${CMAKE_SOURCE_DIR}/lib/utf8proc-2.2.0
	${CMAKE_SOURCE_DIR}/lib/cppformat
	${CMAKE_SOURCE_DIR}/lib/whereami/src
	${CMAKE_SOURCE_DIR}/lib/webrtc-8d2248ff
	${CMAKE_SOURCE_DIR}/lib/pocketsphinx-rev13216/include
	${CMAKE_SOURCE_DIR}/lib/pocketsphinx-rev13216/src/libpocketsphinx
	${CMAKE_SOURCE_DIR}/lib/sphinxbase-rev13216/include
	${CMAKE_SOURCE_DIR}/lib/sphinxbase-rev13216/src/libsphinxbase
	${CMAKE_SOURCE_DIR}/lib/sphinx_config
	${CMAKE_SOURCE_DIR}/lib/flite-1.4/include
	${CMAKE_SOURCE_DIR}/lib/flite-1.4
)

# Collect all source files
file(GLOB_RECURSE LIPSYNCENGINE_SOURCES
	"src/cpp/core/*.cpp"
	"src/cpp/audio/*.cpp"
	"src/cpp/recognition/*.cpp"
	"src/cpp/animation/*.cpp"
	"src/cpp/time/*.cpp"
	"src/cpp/tools/*.cpp"
	"src/cpp/logging/*.cpp"
	"src/cpp/exporters/*.cpp"
	"src/cpp/lib/*.cpp"
	"src/cpp/bridge/*.cpp"
	"src/cpp/entry.cpp"
)

# Exclude g2pRules.cpp - it's included by g2p.cpp, not compiled separately
list(FILTER LIPSYNCENGINE_SOURCES EXCLUDE REGEX ".*g2pRules\\.cpp$")
# Exclude NiceCmdLineOutput - CLI-only, requires TCLAP
list(FILTER LIPSYNCENGINE_SOURCES EXCLUDE REGEX ".*NiceCmdLineOutput\\.cpp$")

# Library sources
file(GLOB CPPFORMAT_SOURCES "lib/cppformat/*.cc")
file(GLOB UTF8PROC_SOURCES "lib/utf8proc-2.2.0/*.c")
# Exclude utf8proc_data.c - it's included by utf8proc.c
list(FILTER UTF8PROC_SOURCES EXCLUDE REGEX ".*utf8proc_data\\.c$")
file(GLOB WHEREAMI_SOURCES "lib/whereami/src/*.c")
# Only include WebRTC common_audio/vad (Voice Activity Detection)
file(GLOB WEBRTC_VAD_CC_SOURCES "lib/webrtc-8d2248ff/webrtc/common_audio/vad/*.cc")
file(GLOB WEBRTC_VAD_C_SOURCES "lib/webrtc-8d2248ff/webrtc/common_audio/vad/*.c")
file(GLOB WEBRTC_SIGNAL_SOURCES "lib/webrtc-8d2248ff/webrtc/common_audio/signal_processing/*.c")
list(FILTER WEBRTC_VAD_CC_SOURCES EXCLUDE REGEX ".*_unittest\\.cc$")
list(FILTER WEBRTC_VAD_C_SOURCES EXCLUDE REGEX ".*_unittest\\.c$")
list(FILTER WEBRTC_SIGNAL_SOURCES EXCLUDE REGEX ".*_unittest\\.c$")
# Exclude architecture-specific assembly implementations
list(FILTER WEBRTC_SIGNAL_SOURCES EXCLUDE REGEX ".*_mips\\.c$")
list(FILTER WEBRTC_SIGNAL_SOURCES EXCLUDE REGEX ".*_neon\\.c$")
list(FILTER WEBRTC_SIGNAL_SOURCES EXCLUDE REGEX ".*_armv7\\.c$")
set(WEBRTC_SOURCES ${WEBRTC_VAD_CC_SOURCES} ${WEBRTC_VAD_C_SOURCES} ${WEBRTC_SIGNAL_SOURCES})
# Exclude whereami - platform detection not needed in WASM
set(WHEREAMI_SOURCES "")
file(GLOB_RECURSE POCKETSPHINX_SOURCES "lib/pocketsphinx-rev13216/src/libpocketsphinx/*.c")
file(GLOB_RECURSE SPHINXBASE_SOURCES "lib/sphinxbase-rev13216/src/libsphinxbase/*.c")
file(GLOB_RECURSE FLITE_SOURCES "lib/flite-1.4/src/*.c")
file(GLOB_RECURSE FLITE_LANG_SOURCES "lib/flite-1.4/lang/**/*.c")
# Exclude flite audio drivers and platform-specific files (but keep our stub)
list(FILTER FLITE_SOURCES EXCLUDE REGEX ".*/audio/.*\\.c$")
# Add back the WASM audio stub we need
set(FLITE_SOURCES ${FLITE_SOURCES} "lib/flite-1.4/src/audio/au_wasm_stub.c")
list(FILTER FLITE_SOURCES EXCLUDE REGEX ".*_palmos\\.c$")
list(FILTER FLITE_SOURCES EXCLUDE REGEX ".*_wince\\.c$")
list(FILTER FLITE_SOURCES EXCLUDE REGEX ".*_win32\\.c$")
# Keep only posix mmap for WASM
list(FILTER FLITE_SOURCES EXCLUDE REGEX ".*mmap_none\\.c$")
# Exclude flite raw data files (they're #included by actual source files per original Makefile)
list(FILTER FLITE_LANG_SOURCES EXCLUDE REGEX ".*_data_raw\\.c$")
list(FILTER FLITE_LANG_SOURCES EXCLUDE REGEX ".*/cmu_lex_num_bytes\\.c$")
list(FILTER FLITE_LANG_SOURCES EXCLUDE REGEX ".*/cmu_lex_entries_huff_table\\.c$")
list(FILTER FLITE_LANG_SOURCES EXCLUDE REGEX ".*/cmu_lex_phones_huff_table\\.c$")
set(FLITE_SOURCES ${FLITE_SOURCES} ${FLITE_LANG_SOURCES})

# Create WASM executable
add_executable(lip-sync-engine
	${LIPSYNCENGINE_SOURCES}
	${CPPFORMAT_SOURCES}
	${UTF8PROC_SOURCES}
	${WHEREAMI_SOURCES}
	${WEBRTC_SOURCES}
	${POCKETSPHINX_SOURCES}
	${SPHINXBASE_SOURCES}
	${FLITE_SOURCES}
)

# Compiler flags
target_compile_options(lip-sync-engine PRIVATE
	-Wall
	-Wextra
	-Wno-unused-parameter
	-Wno-unused-variable
	-fexceptions
)

# Preprocessor definitions
target_compile_definitions(lip-sync-engine PRIVATE
	HAVE_CONFIG_H=1
	WEBRTC_POSIX=1
)

# Emscripten linker flags
if(EMSCRIPTEN)
	set_target_properties(lip-sync-engine PROPERTIES
		LINK_FLAGS "\
			-sEXPORTED_FUNCTIONS=_lipsyncengine_init,_lipsyncengine_analyze_pcm16,_lipsyncengine_free,_lipsyncengine_get_last_error,_lipsyncengine_cleanup,_malloc,_free \
			-sEXPORTED_RUNTIME_METHODS=ccall,cwrap,FS,UTF8ToString,allocateUTF8,stringToUTF8,lengthBytesUTF8,HEAP16 \
			-sALLOW_MEMORY_GROWTH=1 \
			-sINITIAL_MEMORY=134217728 \
			-sSTACK_SIZE=5242880 \
			-sFILESYSTEM=1 \
			-sENVIRONMENT=web,worker \
			-sMODULARIZE=1 \
			-sEXPORT_NAME=createLipSyncEngineModule \
			-fexceptions \
			-sDISABLE_EXCEPTION_CATCHING=0 \
			-sASSERTIONS=0 \
			-sALLOW_TABLE_GROWTH=1 \
			-O3 \
			--no-entry \
			--preload-file ${CMAKE_SOURCE_DIR}/models/sphinx@/wasm/res/sphinx"
	)
endif()

# Output directory - outputs lip-sync-engine.js, lip-sync-engine.wasm, lip-sync-engine.data
set_target_properties(lip-sync-engine PROPERTIES
	RUNTIME_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}/dist/wasm"
)
