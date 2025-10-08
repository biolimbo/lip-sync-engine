/* WASM stub for audio streaming - not needed for lip sync */
#include "cst_string.h"
#include "cst_wave.h"
#include "cst_audio.h"

/* Register the audio_streaming_info type with its delete function */
CST_VAL_REGISTER_TYPE(audio_streaming_info,cst_audio_streaming_info)

cst_audio_streaming_info *new_audio_streaming_info(void)
{
    cst_audio_streaming_info *asi =
        cst_alloc(struct cst_audio_streaming_info_struct,1);
    asi->min_buffsize = 256;
    asi->asc = NULL;
    asi->userdata = NULL;
    return asi;
}

void delete_audio_streaming_info(cst_audio_streaming_info *asi)
{
    if (asi)
        cst_free(asi);
}
