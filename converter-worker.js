/* CoreM5S3 TV Converter - Web Worker */
/* Direct FFmpeg Core integration inside Web Worker (Zero external glue worker, Zero document errors) */

importScripts("lib/ffmpeg/ffmpeg-core.js");

let core = null;

async function getCore(onLog) {
  if (core) return core;

  onLog("Iniciando motor FFmpeg WebAssembly...");

  core = await createFFmpegCore({
    locateFile: (path) => {
      if (path.endsWith(".wasm")) {
        return "lib/ffmpeg/ffmpeg-core.wasm";
      }
      return path;
    },
    print: (msg) => {
      onLog(msg);
    },
    printErr: (msg) => {
      onLog(msg);
    }
  });

  core.setLogger((log) => {
    if (log && log.message) {
      onLog(log.message);
    }
  });

  core.setProgress((prog) => {
    if (prog && typeof prog.progress === "number") {
      postMessage({
        type: "ffmpeg_progress",
        progress: Math.max(0, Math.min(1, prog.progress)),
        time: prog.time || 0
      });
    }
  });

  onLog("✓ Motor FFmpeg listo.");
  return core;
}

// Convert File or Blob to Uint8Array
async function readBlobAsUint8Array(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}

// Extract episode info matching convert_episodes.py
function parseEpisodeInfo(filename) {
  const stem = filename.replace(/\.[^/.]+$/, "");
  
  const patterns = [
    /[sS](\d{1,2})[eE](\d{1,2})/,
    /(\d{1,2})x(\d{1,2})/,
    /Season[._ ](\d{1,2})[._ ]Episode[._ ](\d{1,2})/i,
    /(\d{1,2})-(\d{1,2})/,
    /(\d{1,2})[._ ](\d{1,2})\s/
  ];

  for (const pattern of patterns) {
    const m = stem.match(pattern);
    if (m) {
      const season = parseInt(m[1], 10);
      const episode = parseInt(m[2], 10);
      const title = stem.replace(pattern, "").replace(/^[._ -]+|[._ -]+$/g, "");
      return { season, episode, title };
    }
  }
  return null;
}

function generateOutputNames(filename, index) {
  const info = parseEpisodeInfo(filename);
  let base = "";
  if (info) {
    const s = String(info.season).padStart(2, "0");
    const e = String(info.episode).padStart(2, "0");
    base = `S${s}E${e}`;
    if (info.title) {
      const safeTitle = info.title.replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "_").slice(0, 40);
      if (safeTitle) {
        base += `_${safeTitle}`;
      }
    }
  } else {
    base = `EPISODE_${String(index).padStart(3, "0")}`;
  }
  return {
    videoName: `${base}.mjpeg`,
    audioName: `${base}.pcm`,
    baseName: base
  };
}

self.onmessage = async (e) => {
  const data = e.data;
  if (data.type === "INIT") {
    try {
      await getCore((msg) => {
        postMessage({ type: "LOG", message: msg });
      });
      postMessage({ type: "INIT_OK" });
    } catch (err) {
      postMessage({ type: "INIT_ERROR", error: err.message || String(err) });
    }
    return;
  }

  if (data.type === "CONVERT") {
    const { file, options, index } = data;
    const { fps, quality, width, height, audioRate } = options;

    const log = (msg) => postMessage({ type: "LOG", message: msg });

    try {
      const ffmpeg = await getCore(log);

      const names = generateOutputNames(file.name, index);
      log(`Procesando archivo: ${file.name}`);
      log(`Nombres de salida: ${names.videoName} / ${names.audioName}`);
      log(`Configuración: ${width}x${height} @ ${fps} FPS, Calidad JPEG: ${quality}, Audio: ${audioRate} Hz mono s16le`);

      const inputName = `input_${Date.now()}_${file.name.replace(/[^\w.]/g, "_")}`;
      const fileBytes = await readBlobAsUint8Array(file);
      ffmpeg.FS.writeFile(inputName, fileBytes);

      // 1. Extraer frames JPEG usando el mismo filtro y escala que convert_episodes.py
      log("Extrayendo y escalando fotogramas de video...");
      const framePattern = "frame_%06d.jpg";
      const vfScale = `fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`;

      const videoExit = ffmpeg.exec(
        "-y",
        "-i", inputName,
        "-c:v", "mjpeg",
        "-q:v", String(quality),
        "-vf", vfScale,
        "-an",
        framePattern
      );

      if (videoExit !== 0) {
        throw new Error("FFmpeg falló al procesar el video. Código: " + videoExit);
      }

      // Buscar todos los frames generados
      log("Empaquetando frames en contenedor .mjpeg (CoreM5S3 format)...");
      const filesInDir = ffmpeg.FS.readdir(".");
      const frameFiles = filesInDir
        .filter(n => /^frame_\d{6}\.jpg$/.test(n))
        .sort();

      if (frameFiles.length === 0) {
        throw new Error("No se extrajo ningún frame del video.");
      }

      log(`Total de fotogramas extraídos: ${frameFiles.length}`);

      // Empaquetar frames: [4-byte Little Endian frame_size][bytes JPEG][byte opcional de alineación si es impar]
      let totalMjpegBytes = 0;
      const frameBuffers = [];

      for (let i = 0; i < frameFiles.length; i++) {
        const frameData = ffmpeg.FS.readFile(frameFiles[i]);
        frameBuffers.push(frameData);
        totalMjpegBytes += 4 + frameData.length + (frameData.length & 1);

        // Limpiar archivo temporal para liberar memoria
        ffmpeg.FS.unlink(frameFiles[i]);

        if ((i + 1) % 100 === 0 || i + 1 === frameFiles.length) {
          postMessage({
            type: "PACK_PROGRESS",
            current: i + 1,
            total: frameFiles.length
          });
        }
      }

      log(`Construyendo buffer final .mjpeg (${(totalMjpegBytes / (1024 * 1024)).toFixed(2)} MB)...`);
      const mjpegBuffer = new Uint8Array(totalMjpegBytes);
      const dataView = new DataView(mjpegBuffer.buffer);
      let offset = 0;

      for (let i = 0; i < frameBuffers.length; i++) {
        const jpeg = frameBuffers[i];
        const len = jpeg.length;
        // uint32 Little Endian
        dataView.setUint32(offset, len, true);
        offset += 4;
        mjpegBuffer.set(jpeg, offset);
        offset += len;
        if (len & 1) {
          mjpegBuffer[offset] = 0x00;
          offset += 1;
        }
      }

      // 2. Extraer audio en formato raw PCM: s16le, 1 canal, sample rate
      log("Extrayendo pista de audio a PCM s16le mono...");
      const pcmTempName = "output.pcm";
      const audioExit = ffmpeg.exec(
        "-y",
        "-i", inputName,
        "-vn",
        "-ar", String(audioRate),
        "-ac", "1",
        "-sample_fmt", "s16",
        "-f", "s16le",
        pcmTempName
      );

      let pcmBuffer = null;
      if (audioExit === 0) {
        pcmBuffer = ffmpeg.FS.readFile(pcmTempName);
        ffmpeg.FS.unlink(pcmTempName);
        log(`Pista de audio PCM generada (${(pcmBuffer.length / (1024 * 1024)).toFixed(2)} MB)`);
      } else {
        log("Aviso: No se detectó audio (¿video mudo?). Se genera buffer vacío.");
        pcmBuffer = new Uint8Array(0);
      }

      // Limpiar video fuente
      try { ffmpeg.FS.unlink(inputName); } catch (_) {}

      log(`¡Conversión exitosa de ${file.name}!`);

      postMessage({
        type: "CONVERT_OK",
        names: names,
        mjpegData: mjpegBuffer,
        pcmData: pcmBuffer,
        framesCount: frameFiles.length,
        durationSeconds: frameFiles.length / fps
      }, [mjpegBuffer.buffer, pcmBuffer.buffer]);

    } catch (err) {
      log(`ERROR: ${err.message || String(err)}`);
      postMessage({
        type: "CONVERT_ERROR",
        error: err.message || String(err)
      });
    }
  }
};
