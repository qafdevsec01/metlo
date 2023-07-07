#include <dlfcn.h>
#include <stdio.h>

#ifdef _WIN32
#include <stdlib.h>
#include <string.h>
#endif

#include "go_interface.h"

char hasInit = 0;
void *handle;
unsigned char (*metlo_startup)(char *metlo_url,
                               char *api_key,
                               unsigned short backend_port,
                               unsigned short collector_port,
                               char *log_level,
                               char *encryption_key);
unsigned char (*metlo_block_trace)(Metlo_ExchangeStruct data);
void (*metlo_ingest_trace)(Metlo_ApiTrace trace);

unsigned char Metlo_startup(
    char *metlo_url,
    char *api_key,
    unsigned short backend_port,
    unsigned short collector_port,
    char *log_level,
    char *encryption_key)
{
    //  appdata_path
#ifdef __linux__
    // On linux
    handle = dlopen("/opt/metlo/libmetlo.so", RTLD_LAZY);
#endif
#ifdef __APPLE__
    // On Mac
    handle = dlopen("/opt/metlo/libmetlo.so", RTLD_LAZY);
#endif
#ifdef _WIN32
    // On Windows
    char *appdata_path = getenv("APPDATA");
    char *appdata_length = strlen(appdata_path);
    int supplemental_length = 5 + 1 + 5 + 1 + 11 + 1; // local + / + metlo + / + libmetlo.so + 0
    char *total_path = (char *)calloc(appdata_length + supplemental_length, sizeof(char));
    int total_length = appdata_length + supplemental_length;
    strncpy(total_path, appdata_path, appdata_length);
    strncat(total_path, "local/metlo/libmetlo.so", total_length);
    total_path[total_length - 1] = 0;
    handle = dlopen(total_path, RTLD_LAZY);
#endif
    if (handle != 0)
    {
        atexit(handle_cleanup);
        metlo_startup = (unsigned char (*)(char *metlo_url,
                                           char *api_key,
                                           unsigned short backend_port,
                                           unsigned short collector_port,
                                           char *log_level,
                                           char *encryption_key))dlsym(handle, "metlo_startup");
        if (metlo_startup == 0)
        {
            printf("Metlo: Error setting up metlo_startup: %s\n", dlerror());
            hasInit = 0;
            return 0;
        }
        metlo_block_trace = (unsigned char (*)(Metlo_ExchangeStruct data))dlsym(handle, "metlo_block_trace");
        if (metlo_startup == 0)
        {
            printf("Metlo: Error setting up metlo_block_trace: %s\n", dlerror());
            return 0;
        }
        metlo_ingest_trace = (void (*)(Metlo_ApiTrace data))dlsym(handle, "metlo_ingest_trace");
        if (metlo_startup == 0)
        {
            printf("Metlo: Error setting up metlo_ingest_trace: %s\n", dlerror());
            return 0;
        }
        unsigned char resp = metlo_startup(metlo_url, api_key, backend_port, collector_port, log_level, encryption_key);
        hasInit = resp;
        return resp;
    }
    else
    {
        printf("Metlo: Error loading dynamic library: %s\n", dlerror());
        return 0;
    }
}

unsigned char Metlo_block_trace(Metlo_ExchangeStruct data)
{
    if (hasInit == 1)
    {
        return metlo_block_trace(data);
    }
    else
    {
        return 0;
    }
}

void Metlo_ingest_trace(Metlo_ApiTrace trace)
{
    if (hasInit == 1)
    {
        metlo_ingest_trace(trace);
    }
}

void handle_cleanup(void)
{
    if (handle != 0)
    {
        dlclose(handle);
    }
}
