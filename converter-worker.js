/* CoreM5S3 TV Converter - Web Worker */
/* Handles FFmpeg WASM execution and MJPEG / PCM packaging */

importScripts("lib/ffmpeg/ffmpeg.js");
importScripts("lib/ffmpeg/util.js");

const { FFmpeg } = FFmpegWASM;
const { fetchFile, toBlobURL } = FFmpegUtil;

let ffmpeg = null;

async function initFFmpeg(onLog) {
  if (ffmpeg) return ffmpeg;

  ffmpeg = new FFmpeg();

  ffmpeg.on("log", ({ message }) => {
    onLog(message);
  });

  ffmpeg.on("progress", ({ progress, time }) => {
    postMessage({
      type: "ffmpeg_progress",
      progress: Math.max(0, Math.min(1, progress)),
      time: time
    });
  });

  try {
    onLog("Cargando motor local FFmpeg WebAssembly...");
    await ffmpeg.load({
      coreURL: await toBlobURL("lib/ffmpeg/ffmpeg-core.js", "text/javascript"),
      wasmURL: await toBlobURL("lib/ffmpeg/ffmpeg-core.wasm", "application/wasm")
    });
    onLog("FFmpeg WASM cargado correctamente.");
  } catch (err) {
    onLog(`Error cargando FFmpeg: ${err.message || err}. Reintentando carga directa...`);
    await ffmpeg.load({
      coreURL: "lib/ffmpeg/ffmpeg-core.js",
      wasmURL: "lib/ffmpeg/ffmpeg-core.wasm"
    });
  }

  return ffmpeg;
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
      await initFFmpeg((msg) => {
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
      await initFFmpeg(log);

      const names = generateOutputNames(file.name, index);
      log(`Procesando archivo: ${file.name}`);
      log(`Nombres de salida: ${names.videoName} / ${names.audioName}`);
      log(`Configuración: ${width}x${height} @ ${fps} FPS, Calidad JPEG: ${quality}, Audio: ${audioRate} Hz mono s16le`);

      const inputName = `input_${Date.now()}_${file.name.replace(/[^\w.]/g, "_")}`;
      await ffmpeg.writeFile(inputName, await fetchFile(file));

      // 1. Extraer frames JPEG usando el mismo filtro y escala que convert_episodes.py:
      // scale=W:H:force_original_aspect_ratio=decrease,pad=W:H:(ow-iw)/2:(oh-ih)/2:black
      log("Extrayendo y escalando fotogramas de video...");
      const framePattern = "frame_%06d.jpg";
      const vfScale = `fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`;

      const videoExit = await ffmpeg.exec([
        "-y",
        "-i", inputName,
        "-c:v", "mjpeg",
        "-q:v", String(quality),
        "-vf", vfScale,
        "-an",
        framePattern
      ]);

      if (videoExit !== 0) {
        throw new Error("FFmpeg falló al procesar el video. Código: " + videoExit);
      }

      // Buscar todos los frames generados
      log("Empaquetando frames en contenedor .mjpeg (CoreM5S3 format)...");
      const filesInDir = await ffmpeg.listDir(".");
      const frameFiles = filesInDir
        .map(f => f.name)
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
        const frameData = await ffmpeg.readFile(frameFiles[i]);
        frameBuffers.push(frameData);
        // 4 bytes size + length + pad if odd
        totalMjpegBytes += 4 + frameData.length + (frameData.length & 1);

        // Limpiar archivo temporal para ahorrar RAM en WASM
        await ffmpeg.deleteFile(frameFiles[i]);

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
        // struct.pack("<I", frame_size) -> uint32 Little Endian
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
      const audioExit = await ffmpeg.exec([
        "-y",
        "-i", inputName,
        "-vn",
        "-ar", String(audioRate),
        "-ac", "1",
        "-sample_fmt", "s16",
        "-f", "s16le",
        pcmTempName
      ]);

      let pcmBuffer = null;
      if (audioExit === 0) {
        pcmBuffer = await ffmpeg.readFile(pcmTempName);
        await ffmpeg.deleteFile(pcmTempName);
        log(`Pista de audio PCM generada (${(pcmBuffer.length / (1024 * 1024)).toFixed(2)} MB)`);
      } else {
        log("Aviso: No se pudo extraer audio (¿el video carece de pista de sonido?). Se creará PCM de silencio.");
        pcmBuffer = new Uint8Array(0);
      }

      // Limpiar archivo original
      await ffmpeg.deleteFile(inputName);

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
