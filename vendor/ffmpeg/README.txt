@ffmpeg/ffmpeg 0.12.15 (MIT), UMD wrapper copied unmodified from npm.
Vendored same-origin so its worker can run as a classic worker; the 32 MB core is still loaded from the CDN (ffmpegVersion/coreVersion in index.html).
With classWorkerURL, the UMD build starts a module worker, where importScripts is unavailable and loading fails with "Cannot find module".
