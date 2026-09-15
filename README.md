# CoreM5S3 TV Video Converter (Web App)

Aplicación web 100% en el navegador (client-side) para convertir videos al formato de reproducción de **CoreM5S3 TV** (`.mjpeg` con empaquetado custom + `.pcm` raw 16-bit mono), compatible con el firmware de la rama [`feature/dual-display-support`](https://github.com/Martin78b/corem5s3-tv/tree/feature/dual-display-support).

**Acceso directo (GitHub Pages):**
[https://martin78b.github.io/corem5s3-tv-converter/](https://martin78b.github.io/corem5s3-tv-converter/)

---

## Características

- **Sin instalaciones necesarias**: No requiere instalar Python, FFmpeg ni dependencias locales. Todo el procesamiento de video y audio se realiza en tu navegador gracias a **FFmpeg WebAssembly** (`@ffmpeg/ffmpeg`) y Web Workers.
- **Dispositivos soportados**:
  - **M5Stack CoreS3 / CoreS3 SE**: Resolución nativa de **320×240**, 15 FPS, calidad JPEG 8, audio PCM 44,100 Hz mono (s16le).
  - **Waveshare ESP32-S3 Touch LCD 1.54"**: Resolución cuadrada nativa de **240×240**, 15 FPS, calidad JPEG 8, audio PCM 44,100 Hz mono (s16le).
  - **Perfil Personalizado**: Ajusta ancho, alto, FPS, calidad JPEG (1–31) y sample rate de audio a medida.
- **Formato Binario Idéntico a `convert_episodes.py`**:
  - `.mjpeg`: Contenedor binario secuencial donde cada fotograma contiene `[uint32 LE frame_size][JPEG bytes]` con byte de alineación par.
  - `.pcm`: Audio sin compresión raw 16-bit signed mono Little Endian (`s16le`).
- **Detección inteligente de episodios**:
  - Detecta patrones de nombres como `S01E01`, `1x01`, `Season 1 Episode 1` y los formatea automáticamente como `S01E01_Nombre.mjpeg`.
- **Descargas**:
  - Descarga de archivos individuales (`.mjpeg` y `.pcm`) o descarga consolidada en archivo **ZIP** listo para descomprimir en la tarjeta microSD.

---

## Cómo usar

1. Ingresa a [https://martin78b.github.io/corem5s3-tv-converter/](https://martin78b.github.io/corem5s3-tv-converter/).
2. Selecciona tu dispositivo (**M5Stack CoreS3** o **Waveshare 1.54"**).
3. Arrastra uno o varios archivos de video a la zona de carga (MP4, MKV, AVI, MOV, WEBM, etc.).
4. Presiona el botón **"Convertir Archivos"**.
5. Al finalizar, descarga los archivos o presiona **"Descargar Todo en ZIP para MicroSD"**.

### Preparación de la tarjeta MicroSD

1. Formatea la tarjeta microSD en formato **FAT32** (tabla de particiones MBR).
2. Copia los archivos `.mjpeg` y `.pcm` directamente en la **raíz** de la tarjeta microSD (sin subcarpetas).
3. Inserta la microSD en el dispositivo y enciéndelo. ¡El televisor comenzará la reproducción automáticamente con efecto CRT y audio sincronizado!

---