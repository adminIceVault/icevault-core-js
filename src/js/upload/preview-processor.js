/**
 * @fileoverview Ice Vault — Universal Client-Side Graphics Processing Engine.
 * Provides high-performance binary extraction for RAW/PSD previews and modern web compression.
 * * @dependencies
 * - agPsd (Available globally via CDN or window.agPsd)
 * - browser-image-compression (Available globally via window.imageCompression)
 */

/**
 * Array of supported graphic extensions including web formats, raw photography, and project files.
 * @type {string[]}
 */
export const SUPPORTED_GRAPHIC_EXTENSIONS = [
  "nef", "cr2", "cr3", "arw", "dng", "orf", "rw2", "pef", "raf", "3fr",
  "psd", "jpg", "jpeg", "png", "webp", "bmp", "tiff"
];

/**
 * Main orchestration router. Extracts the embedded preview matrix (for RAW/PSD)
 * and compiles it into a compressed, resized target web asset.
 * * @async
 * @param {File} file - Raw File object harvested from file input or drag-and-drop queues.
 * @param {Object} [options={}] - Custom processing configurations.
 * @param {number} [options.maxWidthOrHeight=800] - Boundary limit for the longest image side in pixels.
 * @param {number} [options.quality=0.75] - Compression factor ranging strictly from 0.1 to 1.0.
 * @param {string} [options.outputFormat='image/webp'] - Target destination MIME-type ('image/webp' | 'image/jpeg').
 * @param {boolean} [options.maintainAspectRatio=true] - Preserves original scale proportions if true.
 * @param {boolean} [options.exifOrientation=true] - Instructs the compiler to honor camera orientation metrics.
 * @returns {Promise<Blob>} Transformed, web-optimized graphics Blob payload.
 * @throws {Error} If third-party dependencies are missing or file structures are corrupted.
 */
export async function processToWebp(file, options = {}) {
  // Fail-fast architecture: Validate core compression engine allocation before parsing binaries
  const compressor = window.imageCompression;
  if (!compressor) {
    throw new Error("[Vault Processor] Critical dependency failure: 'browser-image-compression' is not loaded globally.");
  }

  const config = {
    maxWidthOrHeight: options.maxWidthOrHeight || 800,
    quality: options.quality !== undefined ? options.quality : 0.75,
    outputFormat: options.outputFormat || "image/webp",
    maintainAspectRatio: options.maintainAspectRatio !== false,
    exifOrientation: options.exifOrientation !== false,
  };

  const extension = file.name?.split(".").pop().toLowerCase() || "";
  let imageSource = file;

  try {
    // Phase 1 — Extraction Matrix: Normalize heavy specific containers into readable image blobs
    if (extension === "psd") {
      imageSource = await extractPsdPreview(file);
    } else if (
      [
        "nef", "cr2", "cr3", "arw", "dng", "orf", "rw2", "pef", "raf", "3fr"
      ].includes(extension)
    ) {
      imageSource = await extractEmbeddedJpeg(file);
    }

    // Phase 2 — Downscaling & Compression Engine execution
    const compressionOptions = {
      maxWidthOrHeight: config.maxWidthOrHeight,
      initialQuality: config.quality,
      fileType: config.outputFormat,
      useWebWorker: true,
      preserveExif: !config.exifOrientation, // If true, native browsers handle orientation realignment
    };

    return await compressor(imageSource, compressionOptions);
  } catch (error) {
    console.error(`[Vault Image Processor] Abort execution fault on entity: ${file.name}`, error);
    throw error; // Re-throw to allow interface modules to hook fallback visual placeholders
  }
}

/**
 * High-performance low-level binary scanner for RAW camera formats.
 * Locates embedded preview blocks via sequential SOI (0xFFD8) and EOI (0xFFD9) token offsets.
 * * @private
 * @async
 * @param {File} file - Raw photography binary source.
 * @returns {Promise<Blob>} Sliced pure independent image/jpeg data block.
 */
async function extractEmbeddedJpeg(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = function (e) {
      const buffer = e.target.result;
      const u8 = new Uint8Array(buffer);
      const length = u8.length;
      let previews = [];
      let i = 0;

      // Scan the payload for valid JPEG markers
      while (i < length - 1) {
        // Look for SOI (Start of Image) marker: 0xFFD8
        if (u8[i] === 0xff && u8[i + 1] === 0xd8) {
          let start = i;
          let end = -1;
          // Security fence: Limit sub-scans to 10MB ranges to guard against thread lockups
          let searchLimit = Math.min(start + 10 * 1024 * 1024, length - 1);

          for (let j = start + 2; j < searchLimit; j++) {
            // Look for EOI (End of Image) marker: 0xFFD9
            if (u8[j] === 0xff && u8[j + 1] === 0xd9) {
              end = j + 2;
              break;
            }
          }

          if (end !== -1) {
            const size = end - start;
            // Ignore small thumbnail noise (under 50KB); isolate higher resolution previews
            if (size > 50 * 1024) {
              previews.push({ start, end, size });
            }
            i = end;
            continue;
          }
        }
        i++;
      }

      if (previews.length > 0) {
        // Extract the largest available preview matrix asset
        previews.sort((a, b) => b.size - a.size);
        const bestPreview = previews[0];
        const jpegBlob = new Blob(
          [buffer.slice(bestPreview.start, bestPreview.end)],
          { type: "image/jpeg" }
        );
        resolve(jpegBlob);
      } else {
        reject(new Error("No valid embedded preview found within RAW metadata structures."));
      }
    };

    reader.onerror = () => reject(new Error("File API reader failure: ArrayBuffer pipeline crashed."));

    // Chunk allocation: Read up to 20MB of header data to optimize memory allocations
    const sliceAmount = Math.min(file.size, 20 * 1024 * 1024);
    reader.readAsArrayBuffer(file.slice(0, sliceAmount));
  });
}

/**
 * Structural parser for Adobe Photoshop (.psd) files.
 * Extracts the pre-flattened compatibility canvas container without parsing heavy layer stacks.
 * * @private
 * @async
 * @param {File} file - Source Photoshop document.
 * @returns {Promise<Blob>} Exported image/jpeg rendering canvas image.
 */
async function extractPsdPreview(file) {
  return new Promise((resolve, reject) => {
    if (!window.agPsd) {
      reject(new Error("Critical dependency failure: 'ag-psd' library context missing."));
      return;
    }

    const reader = new FileReader();
    reader.onload = function (e) {
      try {
        const buffer = e.target.result;
        // Optimization: skipLayerData skips tree indexing, fetching only the composite frame layout
        const psd = window.agPsd.readPsd(buffer, { skipLayerData: true });

        if (psd.canvas) {
          psd.canvas.toBlob(
            (blob) => {
              // Memory Leak Prevention: Explicitly release and unbind HTML Canvas resources
              psd.canvas.width = psd.canvas.height = 0;

              if (blob) {
                resolve(blob);
              } else {
                reject(new Error("Canvas export pipeline failed to generate binary Blob object."));
              }
            },
            "image/jpeg",
            0.9
          );
        } else {
          reject(new Error("No backward compatibility composite preview detected in PSD configuration."));
        }
      } catch (err) {
        reject(new Error(`PSD structural parsing crash: ${err.message}`));
      }
    };

    reader.onerror = () => reject(new Error("File API reader failure: ArrayBuffer pipeline crashed."));
    reader.readAsArrayBuffer(file);
  });
}