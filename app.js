/* CoreM5S3 TV Web Converter - Main Application Controller */

let filesQueue = [];
let convertedResults = [];
let worker = null;
let isConverting = false;

// Device configurations
const DEVICE_PRESETS = {
  m5stack: {
    name: "M5Stack CoreS3 / CoreS3 SE",
    width: 320,
    height: 240,
    fps: 15,
    quality: 8,
    audioRate: 44100
  },
  waveshare: {
    name: "Waveshare ESP32-S3 Touch LCD 1.54\"",
    width: 240,
    height: 240,
    fps: 15,
    quality: 8,
    audioRate: 44100
  },
  custom: {
    name: "Personalizado"
  }
};

document.addEventListener("DOMContentLoaded", () => {
  initWorker();
  initUI();
});

function initWorker() {
  if (worker) worker.terminate();

  // Cache buster para evitar que el navegador reutilice versiones viejas en cache
  worker = new Worker(`converter-worker.js?v=${Date.now()}`);

  worker.onmessage = (e) => {
    const data = e.data;
    switch (data.type) {
      case "LOG":
        appendLog(data.message);
        break;
      case "INIT_OK":
        appendLog("✓ Motor FFmpeg WebAssembly listo para convertir.");
        break;
      case "INIT_ERROR":
        appendLog(`⚠ Error inicializando motor: ${data.error}`);
        break;
      case "ffmpeg_progress":
        if (data.progress > 0) {
          updateProgressBar(Math.round(data.progress * 80), `Extrayendo frames: ${Math.round(data.progress * 100)}%`);
        }
        break;
      case "PACK_PROGRESS":
        const pct = 80 + Math.round((data.current / data.total) * 20);
        updateProgressBar(pct, `Empaquetando MJPEG: frame ${data.current}/${data.total}`);
        break;
      case "CONVERT_OK":
        handleConversionComplete(data);
        break;
      case "CONVERT_ERROR":
        handleConversionError(data.error);
        break;
    }
  };

  // Pre-initialize worker
  worker.postMessage({ type: "INIT" });
}

function initUI() {
  const fileInput = document.getElementById("file-input");
  const dropzone = document.getElementById("dropzone");
  const btnSelect = document.getElementById("btn-select-files");
  const btnConvert = document.getElementById("btn-start-convert");
  const btnDownloadAll = document.getElementById("btn-download-all");
  const radioButtons = document.querySelectorAll('input[name="device"]');

  // Preset selector
  radioButtons.forEach((radio) => {
    radio.addEventListener("change", (e) => {
      document.querySelectorAll(".device-card").forEach(c => c.classList.remove("active"));
      const card = e.target.closest(".device-card");
      if (card) card.classList.add("active");

      const preset = DEVICE_PRESETS[e.target.value];
      if (preset && e.target.value !== "custom") {
        document.getElementById("input-width").value = preset.width;
        document.getElementById("input-height").value = preset.height;
        document.getElementById("input-fps").value = preset.fps;
        document.getElementById("input-quality").value = preset.quality;
        document.getElementById("input-audiorate").value = preset.audioRate;
      }
    });
  });

  // Drag and Drop
  btnSelect.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("click", (e) => {
    if (e.target !== btnSelect && !btnSelect.contains(e.target)) {
      fileInput.click();
    }
  });

  ["dragenter", "dragover"].forEach(event => {
    dropzone.addEventListener(event, (e) => {
      e.preventDefault();
      dropzone.classList.add("dragover");
    });
  });

  ["dragleave", "drop"].forEach(event => {
    dropzone.addEventListener(event, (e) => {
      e.preventDefault();
      dropzone.classList.remove("dragover");
    });
  });

  dropzone.addEventListener("drop", (e) => {
    const droppedFiles = Array.from(e.dataTransfer.files).filter(isValidVideoFile);
    addFilesToQueue(droppedFiles);
  });

  fileInput.addEventListener("change", (e) => {
    const selectedFiles = Array.from(e.target.files).filter(isValidVideoFile);
    addFilesToQueue(selectedFiles);
    fileInput.value = "";
  });

  // Buttons
  btnConvert.addEventListener("click", startBatchConversion);
  btnDownloadAll.addEventListener("click", downloadAllAsZip);
}

function isValidVideoFile(file) {
  const validExts = [".mp4", ".mkv", ".avi", ".mov", ".m4v", ".wmv", ".flv", ".webm", ".ts", ".mpeg", ".mpg", ".3gp"];
  const name = file.name.toLowerCase();
  return validExts.some(ext => name.endsWith(ext)) || file.type.startsWith("video/");
}

function addFilesToQueue(newFiles) {
  if (!newFiles.length) return;
  newFiles.forEach((file) => {
    filesQueue.push({
      file: file,
      status: "pending" // pending, converting, success, error
    });
  });
  renderQueue();
  updateConvertButtonState();
}

function renderQueue() {
  const container = document.getElementById("queue-container");
  container.innerHTML = "";

  if (filesQueue.length === 0) {
    container.style.display = "none";
    return;
  }
  container.style.display = "flex";

  filesQueue.forEach((item, index) => {
    const el = document.createElement("div");
    el.className = "queue-item";

    const sizeMb = (item.file.size / (1024 * 1024)).toFixed(1);
    let statusText = "En espera";
    let statusClass = "status-pending";

    if (item.status === "converting") {
      statusText = "Convirtiendo...";
      statusClass = "status-converting";
    } else if (item.status === "success") {
      statusText = "Completado ✓";
      statusClass = "status-success";
    } else if (item.status === "error") {
      statusText = "Error ✗";
      statusClass = "status-error";
    }

    el.innerHTML = `
      <div class="queue-item-info">
        <span class="queue-item-name" title="${item.file.name}">${item.file.name}</span>
        <div class="queue-item-meta">
          <span>${sizeMb} MB</span>
          <span class="queue-item-status ${statusClass}">${statusText}</span>
        </div>
      </div>
      ${
        !isConverting
          ? `<button class="btn-remove" onclick="removeQueueItem(${index})" title="Eliminar">&times;</button>`
          : ""
      }
    `;
    container.appendChild(el);
  });
}

window.removeQueueItem = function(index) {
  if (isConverting) return;
  filesQueue.splice(index, 1);
  renderQueue();
  updateConvertButtonState();
};

function updateConvertButtonState() {
  const btnConvert = document.getElementById("btn-start-convert");
  const pendingCount = filesQueue.filter(f => f.status === "pending").length;
  btnConvert.disabled = isConverting || pendingCount === 0;
  btnConvert.innerHTML = `
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <polygon points="5 3 19 12 5 21 5 3"/>
    </svg>
    ${isConverting ? "Convirtiendo..." : `Convertir ${pendingCount} archivo(s)`}
  `;
}

async function startBatchConversion() {
  if (isConverting) return;
  const pendingIndex = filesQueue.findIndex(f => f.status === "pending");
  if (pendingIndex === -1) return;

  isConverting = true;
  updateConvertButtonState();
  showProgressBox(true);

  const options = {
    width: parseInt(document.getElementById("input-width").value, 10) || 240,
    height: parseInt(document.getElementById("input-height").value, 10) || 240,
    fps: parseInt(document.getElementById("input-fps").value, 10) || 15,
    quality: parseInt(document.getElementById("input-quality").value, 10) || 8,
    audioRate: parseInt(document.getElementById("input-audiorate").value, 10) || 44100
  };

  convertNextFile(options);
}

function convertNextFile(options) {
  const nextItemIndex = filesQueue.findIndex(f => f.status === "pending");
  if (nextItemIndex === -1) {
    isConverting = false;
    updateConvertButtonState();
    appendLog("🎉 ¡Todos los archivos han sido procesados!");
    updateProgressBar(100, "¡Conversión finalizada con éxito!");
    return;
  }

  const currentItem = filesQueue[nextItemIndex];
  currentItem.status = "converting";
  renderQueue();

  updateProgressBar(0, `Iniciando: ${currentItem.file.name}`);

  worker.postMessage({
    type: "CONVERT",
    file: currentItem.file,
    options: options,
    index: nextItemIndex + 1
  });
}

function handleConversionComplete(data) {
  const currentItem = filesQueue.find(f => f.status === "converting");
  if (currentItem) {
    currentItem.status = "success";
  }

  // Save converted result for download
  const mjpegBlob = new Blob([data.mjpegData], { type: "application/octet-stream" });
  const pcmBlob = new Blob([data.pcmData], { type: "application/octet-stream" });

  const result = {
    baseName: data.names.baseName,
    videoName: data.names.videoName,
    audioName: data.names.audioName,
    mjpegBlob: mjpegBlob,
    pcmBlob: pcmBlob,
    mjpegSize: mjpegBlob.size,
    pcmSize: pcmBlob.size,
    frames: data.framesCount,
    duration: data.durationSeconds
  };

  convertedResults.push(result);
  renderResults();

  // Next file
  const options = {
    width: parseInt(document.getElementById("input-width").value, 10) || 240,
    height: parseInt(document.getElementById("input-height").value, 10) || 240,
    fps: parseInt(document.getElementById("input-fps").value, 10) || 15,
    quality: parseInt(document.getElementById("input-quality").value, 10) || 8,
    audioRate: parseInt(document.getElementById("input-audiorate").value, 10) || 44100
  };

  convertNextFile(options);
}

function handleConversionError(errorMsg) {
  const currentItem = filesQueue.find(f => f.status === "converting");
  if (currentItem) {
    currentItem.status = "error";
  }
  renderQueue();
  appendLog(`✗ Error al convertir: ${errorMsg}`);
  
  // Continue with the remaining
  const options = {
    width: parseInt(document.getElementById("input-width").value, 10) || 240,
    height: parseInt(document.getElementById("input-height").value, 10) || 240,
    fps: parseInt(document.getElementById("input-fps").value, 10) || 15,
    quality: parseInt(document.getElementById("input-quality").value, 10) || 8,
    audioRate: parseInt(document.getElementById("input-audiorate").value, 10) || 44100
  };

  convertNextFile(options);
}

function renderResults() {
  const panel = document.getElementById("results-panel");
  const list = document.getElementById("results-list");
  const btnDownloadAll = document.getElementById("btn-download-all");

  if (convertedResults.length === 0) {
    panel.style.display = "none";
    return;
  }

  panel.style.display = "block";
  btnDownloadAll.disabled = false;
  list.innerHTML = "";

  convertedResults.forEach((res, idx) => {
    const card = document.createElement("div");
    card.className = "result-card";

    const vMb = (res.mjpegSize / (1024 * 1024)).toFixed(1);
    const aMb = (res.pcmSize / (1024 * 1024)).toFixed(1);

    const mjpegUrl = URL.createObjectURL(res.mjpegBlob);
    const pcmUrl = URL.createObjectURL(res.pcmBlob);

    card.innerHTML = `
      <div class="result-info">
        <span class="result-title">${res.baseName}</span>
        <span class="result-sub">${res.frames} frames (${res.duration.toFixed(1)}s) • Video: ${vMb} MB • Audio: ${aMb} MB</span>
      </div>
      <div class="result-buttons">
        <a class="btn-download-small" href="${mjpegUrl}" download="${res.videoName}">
          Descargar .mjpeg
        </a>
        <a class="btn-download-small" href="${pcmUrl}" download="${res.audioName}">
          Descargar .pcm
        </a>
      </div>
    `;
    list.appendChild(card);
  });
}

async function downloadAllAsZip() {
  if (convertedResults.length === 0) return;
  const btn = document.getElementById("btn-download-all");
  const origText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = "Generando archivo ZIP...";

  try {
    const zip = new JSZip();
    convertedResults.forEach(res => {
      zip.file(res.videoName, res.mjpegBlob);
      zip.file(res.audioName, res.pcmBlob);
    });

    const zipContent = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(zipContent);
    const a = document.createElement("a");
    a.href = url;
    a.download = "CoreM5S3_TV_SDCard_Files.zip";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    appendLog("✓ Archivo ZIP listo y descargado.");
  } catch (err) {
    alert("Error al comprimir ZIP: " + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = origText;
  }
}

function updateProgressBar(percentage, statusText) {
  const bar = document.getElementById("progress-bar-fill");
  const text = document.getElementById("progress-status");
  const pctText = document.getElementById("progress-percentage");

  if (bar) bar.style.width = `${percentage}%`;
  if (text && statusText) text.textContent = statusText;
  if (pctText) pctText.textContent = `${percentage}%`;
}

function showProgressBox(show) {
  const box = document.getElementById("progress-box");
  if (box) box.style.display = show ? "block" : "none";
}

function appendLog(msg) {
  const consoleBox = document.getElementById("console-box");
  if (!consoleBox) return;

  const entry = document.createElement("div");
  entry.className = "console-entry";
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  consoleBox.appendChild(entry);
  consoleBox.scrollTop = consoleBox.scrollHeight;
}
