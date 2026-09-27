// Disposable macOS CI: capture only the named virtual output, never a mic.
#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef struct {
    float *samples;
    unsigned limit;
    atomic_uint count;
} Capture;

static void check(OSStatus status, const char *operation) {
    if (status != noErr) {
        fprintf(stderr, "%s failed: %d\n", operation, (int)status);
        exit(1);
    }
}

static OSStatus record(AudioDeviceID device, const AudioTimeStamp *now,
    const AudioBufferList *input, const AudioTimeStamp *inputTime,
    AudioBufferList *output, const AudioTimeStamp *outputTime, void *context) {
    Capture *capture = context;
    unsigned count = atomic_load_explicit(&capture->count, memory_order_relaxed);
    if (input && input->mNumberBuffers) {
        const AudioBuffer *buffer = &input->mBuffers[0];
        if (buffer->mData && buffer->mNumberChannels) {
            const float *data = buffer->mData;
            unsigned frames = buffer->mDataByteSize / sizeof(float) / buffer->mNumberChannels;
            for (unsigned frame = 0; frame < frames && count < capture->limit; frame++)
                capture->samples[count++] = data[frame * buffer->mNumberChannels];
            atomic_store_explicit(&capture->count, count, memory_order_release);
        }
    }
    // This recorder contributes silence on its own output bus.
    if (output) for (unsigned i = 0; i < output->mNumberBuffers; i++)
        if (output->mBuffers[i].mData) memset(output->mBuffers[i].mData, 0, output->mBuffers[i].mDataByteSize);
    return noErr;
}

int main(void) {
    const char *ci = getenv("CI"), *name = getenv("TROOM_AUDIO_LOOPBACK");
    if (!ci || strcmp(ci, "true") || !name || strcmp(name, "BlackHole 2ch")) {
        fprintf(stderr, "Only explicitly configured disposable CI may capture audio\n");
        return 1;
    }
    AudioObjectPropertyAddress devicesProperty = {
        kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain
    };
    UInt32 size = 0;
    check(AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &devicesProperty, 0, NULL, &size), "device list size");
    if (size > 4096) return 1;
    AudioDeviceID devices[1024];
    check(AudioObjectGetPropertyData(kAudioObjectSystemObject, &devicesProperty, 0, NULL, &size, devices), "device list");
    AudioDeviceID selected = kAudioObjectUnknown;
    for (unsigned i = 0; i < size / sizeof(AudioDeviceID); i++) {
        AudioObjectPropertyAddress property = {
            kAudioObjectPropertyName, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain
        };
        CFStringRef deviceName = NULL;
        UInt32 nameSize = sizeof(deviceName);
        check(AudioObjectGetPropertyData(devices[i], &property, 0, NULL, &nameSize, &deviceName), "device name");
        char value[256];
        if (deviceName && CFStringGetCString(deviceName, value, sizeof(value), kCFStringEncodingUTF8) && !strcmp(value, name)) selected = devices[i];
        if (deviceName) CFRelease(deviceName);
    }
    if (selected == kAudioObjectUnknown) { fprintf(stderr, "Named virtual device absent\n"); return 1; }
    AudioObjectPropertyAddress formatProperty = {
        kAudioDevicePropertyStreamFormat, kAudioDevicePropertyScopeInput, kAudioObjectPropertyElementMain
    };
    AudioStreamBasicDescription format = {0};
    size = sizeof(format);
    check(AudioObjectGetPropertyData(selected, &formatProperty, 0, NULL, &size, &format), "input format");
    if (format.mFormatID != kAudioFormatLinearPCM || !(format.mFormatFlags & kAudioFormatFlagIsFloat)
        || (format.mFormatFlags & kAudioFormatFlagIsBigEndian) || format.mBitsPerChannel != 32
        || format.mSampleRate < 44100 || format.mSampleRate > 48000 || !format.mChannelsPerFrame) {
        fprintf(stderr, "Unexpected virtual device PCM format\n"); return 1;
    }
    Capture capture = { .limit = (unsigned)format.mSampleRate };
    atomic_init(&capture.count, 0);
    capture.samples = calloc(capture.limit, sizeof(float));
    if (!capture.samples) return 1;
    AudioDeviceIOProcID proc = NULL;
    check(AudioDeviceCreateIOProcID(selected, record, &capture, &proc), "create recorder");
    check(AudioDeviceStart(selected, proc), "start recorder");
    for (unsigned elapsed = 0; elapsed < 500 && atomic_load_explicit(&capture.count, memory_order_acquire) < capture.limit; elapsed++) usleep(10000);
    check(AudioDeviceStop(selected, proc), "stop recorder");
    check(AudioDeviceDestroyIOProcID(selected, proc), "destroy recorder");
    unsigned count = atomic_load_explicit(&capture.count, memory_order_acquire);
    if (count != capture.limit) { fprintf(stderr, "Recorder did not acquire one second of PCM\n"); free(capture.samples); return 1; }
    printf("{\"sampleRate\":%.0f,\"channels\":%u,\"device\":\"BlackHole 2ch\"}\n", format.mSampleRate, format.mChannelsPerFrame);
    fwrite(capture.samples, sizeof(float), count, stdout);
    free(capture.samples);
    return ferror(stdout) ? 1 : 0;
}
