import {
  processToWebp,
  SUPPORTED_GRAPHIC_EXTENSIONS,
} from "./preview-processor.js";

(function () {
  "use strict";

  // --- CONFIGURATION & CONSTANTS ---
  const TMP_PREVIEW_FILENAME = "tmp_preview.zip";
  const TMP_ARCHIVE_FILENAME = "tmp_archive.zip";
  const DEFAULT_FALLBACK_FILENAME = "tmp_file.zip";

  const API = {
    INIT: "/api/storage/initiate-upload/",
    CONFIRM: "/api/storage/confirm-upload/",
    CHUNK_SIZE: 100 * 1024 * 1024, // 100MB chunk allocation
  };

  const UI_DEFAULTS = {
    PREVIEW_MAX_WIDTH: 800,
    PREVIEW_QUALITY: 75,
    VIDEO_PREVIEW_DURATION: "10",
    VIDEO_SCALE: "-2:360",
    RETRY_ATTEMPTS: 3,
    RETRY_DELAY_MS: 1500,
  };

  // --- EXTERNAL DEPENDENCIES INITIALIZATION ---
  const { createFFmpeg, fetchFile } = FFmpeg;
  const ffmpeg = createFFmpeg({ log: false });
  let ffmpegLoaded = false;
  window.isProcessing = false;

  /**
   * Initializes FFmpeg WASM if not already loaded.
   */
  async function initFFmpeg() {
    if (!ffmpegLoaded) {
      await ffmpeg.load();
      ffmpegLoaded = true;
    }
  }

  // --- RUNTIME STATE ---
  let state = {
    totalBytes: 0,
  };

  // --- DOM & UTILITY HELPERS ---
  const getEl = (id) => document.getElementById(id);
  const toKB = (bytes) => Math.round(bytes / 1024);

  /**
   * Calculates the number of chunks for multi-part binary streaming.
   * @param {number} size - File size in bytes.
   * @returns {number} Minimum 1 part.
   */
  const getPartCount = function (size) {
    console.log("Calculated part count:", size, API.CHUNK_SIZE);
    return Math.ceil(size / API.CHUNK_SIZE) || 1;
  };

  /**
   * Resolves the target vault filename from the DOM input or generates a timestamped fallback.
   * @returns {string} Fully qualified zip filename.
   */
  function getArchiveName() {
    const input = getEl("archive-name-input");
    let name = input?.value.trim();
    if (!name) {
      const now = new Date();
      name = `vault_${now.toISOString().split("T")[0]}_${now.getHours()}-${now.getMinutes()}`;
    }
    return name.endsWith(".zip") ? name : name + ".zip";
  }

  // --- COMPILATION ENGINE (OPFS VIRTUAL FILE SYSTEM) ---

  /**
   * Universal streaming compiler that writes a ZIP archive (plain or AES-256 encrypted)
   * directly to the Origin Private File System (OPFS) to bypass browser memory thresholds.
   * @param {Array} files - Array of unified file nodes or objects containing {name, data, archivePath}.
   * @param {string} filename - Destined storage asset identifier.
   * @param {string} tmp_filename - Sandbox block tracking handle.
   * @param {string|null} password - Private key for AES-256 payload encryption.
   * @returns {Promise<File>} Hand-off descriptor for AWS binary transmission.
   */
  async function createZipArchive(
    files,
    filename,
    tmp_filename = DEFAULT_FALLBACK_FILENAME,
    password = null,
  ) {
    const root = await navigator.storage.getDirectory();

    // Evict old allocation tracks if they exist
    try {
      await root.removeEntry(tmp_filename);
    } catch (e) {}

    const tempFileHandle = await root.getFileHandle(tmp_filename, {
      create: true,
    });

    // Create a high-performance raw writable interface stream
    const writableStream = await tempFileHandle.createWritable();
    const zipConfig = { bufferedWrite: true };

    window.UploadModalManager.updateProgress(0, "packing_payload");

    // Aggregate baseline bytes for fine-grained compression telemetry
    const totalBytes = files.reduce((acc, file) => {
      const data = file.data !== undefined ? file.data : file;
      return acc + (data.size || 0);
    }, 0);

    let bytesProcessedSoFar = 0;

    if (password && password.trim() !== "") {
      zipConfig.password = password.trim();
      zipConfig.zipCrypto = false; // Force modern AES-256 compliance over legacy ZipCrypto

      window.UploadModalManager.writeLog(
        `SECURE_UPLINK: Encrypting vault with AES-256 (OPFS Mode)...`,
      );
    }

    const zipWriter = new zip.ZipWriter(writableStream, zipConfig);
    try {
      let currentFileIndex = 0;
      const totalFilesCount = files.length;

      for (const file of files) {
        currentFileIndex++;

        const data = file.data !== undefined ? file.data : file;
        const name = file.name;
        const archivePath = file.archivePath || name; // Maintain strict nested tree hierarchy
        const fileSize = data.size || 0;

        const blobReader = new zip.BlobReader(
          data instanceof Blob ? data : new Blob([data]),
        );

        window.UploadModalManager.writeLog(
          `PACKING: [${currentFileIndex}/${totalFilesCount}] ${archivePath}...`,
        );

        await zipWriter.add(archivePath, blobReader, {
          onprogress: (loaded, total) => {
            if (!totalBytes || totalBytes === 0) return;
            if (typeof loaded === "number" && total > 0) {
              const currentLoaded = Math.min(loaded, total);
              const overallLoaded = bytesProcessedSoFar + currentLoaded;
              const percentage = Math.min(
                Math.round((overallLoaded / totalBytes) * 100),
                100,
              );

              window.UploadModalManager.updateProgress(
                percentage,
                "packing_payload",
              );
            }
          },
        });

        bytesProcessedSoFar += fileSize;
      }

      window.UploadModalManager.writeLog(
        `FINALIZING: Writing central directory to disk...`,
      );
      await zipWriter.close();

      window.UploadModalManager.writeLog(
        `SUCCESS: Vault compiled on storage. Ready for AWS transmission.`,
      );

      const finalFile = await tempFileHandle.getFile();
      window.UploadModalManager.writeLog(`SUCCESS: Archive ready on disk.`);

      return new File([finalFile], filename, { type: "application/zip" });
    } catch (error) {
      window.UploadModalManager.writeLog(
        `CRITICAL_ERROR: OPFS Archiving failed!`,
      );
      console.error(`[Archive] Error:`, error);
      throw error;
    }
  }

  /**
   * Generates derivative low-fidelity quick-view assets (WebP thumbs, lightweight MP4 streams, metadata).
   * @param {Array} files - Raw queue buffers.
   * @returns {Promise<Array>} Non-destructive structural projection of asset proxies.
   */
  async function generatePreviewContent(files) {
    const previewFiles = [];
    const maxWidth = parseInt(
      getEl("preview-size-input")?.value || UI_DEFAULTS.PREVIEW_MAX_WIDTH,
    );
    const quality =
      parseInt(
        getEl("preview-quality-input")?.value || UI_DEFAULTS.PREVIEW_QUALITY,
      ) / 100;
    const isUploadingOriginals =
      getEl("upload-originals-checkbox")?.checked ?? true;

    for (const file of files) {
      const originalPath = file.archivePath || file.name;
      const lastSlashIndex = originalPath.lastIndexOf("/");
      const dirPath =
        lastSlashIndex !== -1
          ? originalPath.substring(0, lastSlashIndex + 1)
          : "";

      try {
        let isImage = file.type.startsWith("image/");
        const fileExtension = file.name?.split(".").pop().toLowerCase();
        if (SUPPORTED_GRAPHIC_EXTENSIONS.includes(fileExtension)) {
          isImage = true;
        }

        // 1. IMAGE PROCESSING
        if (isImage) {
          const compressed = await processToWebp(file, {
            maxWidthOrHeight: maxWidth,
            quality: quality,
            outputFormat: "image/webp",
          });

          const newName = `thumb_${file.name}.webp`;
          previewFiles.push({
            name: newName,
            archivePath: dirPath + newName,
            data: compressed,
          });
        }
        // 2. VIDEO PROCESSING (WASM TRANSCODING)
        else if (file.type.startsWith("video/")) {
          window.UploadModalManager.writeLog(
            `Processing video preview: ${file.name}...`,
            "info",
          );
          await initFFmpeg();
          ffmpeg.FS("writeFile", "temp_input", await fetchFile(file));
          await ffmpeg.run(
            "-t",
            UI_DEFAULTS.VIDEO_PREVIEW_DURATION,
            "-i",
            "temp_input",
            "-vf",
            `scale=${UI_DEFAULTS.VIDEO_SCALE},eq=saturation=1.2`,
            "-preset",
            "ultrafast",
            "-c:v",
            "libx264",
            "-crf",
            "30",
            "-an",
            "-movflags",
            "faststart",
            "fast_preview.mp4",
          );

          const data = ffmpeg.FS("readFile", "fast_preview.mp4");
          const newName = `preview_${file.name.split(".")[0]}.mp4`;

          previewFiles.push({
            name: newName,
            archivePath: dirPath + newName,
            data: data.buffer,
          });

          ffmpeg.FS("unlink", "temp_input");
          ffmpeg.FS("unlink", "fast_preview.mp4");
        }
        // 3. PLAINTEXT / INSPECTION LOGS
        else if (file.type === "text/plain" || file.name.endsWith(".log")) {
          const text = await file.text();
          const newName = `meta_${file.name}`;
          previewFiles.push({
            name: newName,
            archivePath: dirPath + newName,
            data: text,
          });
        }
        // 4. PLACEHOLDERS / ARCHIVE INDEX TRACKERS
        else {
          previewFiles.push({
            name: file.name,
            archivePath: originalPath,
            data: !isUploadingOriginals ? file : "",
          });
        }
      } catch (e) {
        window.UploadModalManager.writeLog(
          `Failed preview for: ${file.name}`,
          "warn",
        );
        previewFiles.push({
          name: file.name,
          archivePath: originalPath,
          data: "",
        });
        console.error(e);
      }
    }
    return previewFiles;
  }

  /**
   * Generates standard cryptographic MD5 checksum.
   */
  function calculateMD5(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsArrayBuffer(file);
      reader.onload = (e) => {
        const buffer = e.target.result;
        const hash = SparkMD5.ArrayBuffer.hash(buffer);
        resolve(hash);
      };
      reader.onerror = reject;
    });
  }

  // --- 3. NETWORK TRANSMISSION LAYER (S3 / CLOUDFLARE R2 UPLINK) ---

  /**
   * Handles binary stream transmission to object storage destination targets.
   * Automatically isolates Multi-part parallel processing from single PUT pipeline tracking.
   * @param {Object} uploadMeta - Infrastructure signing profiles from server response block.
   * @param {File} file - Physical binary payload asset hook.
   * @param {string} typeLabel - Contextual runtime debugging tag ("PREVIEW" | "ARCHIVE").
   * @returns {Promise<Object>} MD5 checksum structure mappings for tracking validation.
   */
  async function uploadToS3(uploadMeta, file, typeLabel) {
    window.UploadModalManager.updateProgress(0, "uploading_stream");

    const uploadType = uploadMeta.upload_type;
    const partsUrls = uploadMeta.part_urls || {};
    const targetUrl = partsUrls[1] || partsUrls["1"] || uploadMeta.url;

    if (!targetUrl) {
      throw new Error(`No URL provided for uploading ${typeLabel}`);
    }

    // --- MULTI-PART ACCELERATED TRANSMISSION ---
    if (uploadType === "multipart") {
      const partSize = API.CHUNK_SIZE;
      const totalParts = Object.keys(partsUrls).length;
      const completedPartsHashes = {};

      console.group(`[MULTIPART PUT] ${typeLabel}`);

      try {
        for (let i = 1; i <= totalParts; i++) {
          const chunkUrl = partsUrls[i] || partsUrls[String(i)];
          if (!chunkUrl) throw new Error(`Missing URL for part ${i}`);

          const start = (i - 1) * partSize;
          const end = Math.min(start + partSize, file.size);
          const chunk = file.slice(start, end);

          let attempt = 0;
          let success = false;
          let response;

          // Fault-tolerant stream looping block
          while (attempt < UI_DEFAULTS.RETRY_ATTEMPTS && !success) {
            try {
              attempt++;
              if (attempt > 1) {
                window.UploadModalManager.writeLog(
                  `RETRY: Retrying part ${i}/${totalParts} (Attempt ${attempt}/${UI_DEFAULTS.RETRY_ATTEMPTS})...`,
                  "warning",
                );
                await new Promise((resolve) =>
                  setTimeout(resolve, UI_DEFAULTS.RETRY_DELAY_MS),
                );
              } else {
                window.UploadModalManager.writeLog(
                  `STREAMING: Sending part ${i}/${totalParts} (${toKB(chunk.size)} KB)...`,
                );
              }

              response = await axios.put(chunkUrl, chunk, {
                headers: { "Content-Type": "application/octet-stream" },
                onUploadProgress: (e) => {
                  const loadedBefore = (i - 1) * partSize;
                  const currentTotalLoaded = loadedBefore + e.loaded;
                  const percent = Math.min(
                    Math.round((currentTotalLoaded * 100) / file.size),
                    100,
                  );
                  window.UploadModalManager.updateProgress(
                    percent,
                    "uploading_stream",
                  );
                },
              });

              success = true;
            } catch (chunkErr) {
              console.warn(`Part ${i} failed on attempt ${attempt}:`, chunkErr);
              if (attempt >= UI_DEFAULTS.RETRY_ATTEMPTS) {
                throw new Error(
                  `Failed to upload part ${i} after ${UI_DEFAULTS.RETRY_ATTEMPTS} attempts. Error: ${chunkErr.message}`,
                );
              }
            }
          }

          const etag = response.headers["etag"] || response.headers["ETag"];
          if (!etag)
            throw new Error(`Server did not return ETag for part ${i}`);

          completedPartsHashes[i] = etag.replace(/"/g, "");
        }

        console.groupEnd();
        window.UploadModalManager.writeLog(
          `${typeLabel} multipart streaming complete.`,
          "success",
        );
        return completedPartsHashes;
      } catch (err) {
        console.groupEnd();
        throw err;
      }
    }
    // --- SINGLE TRANSACTION PUT (Optimized Clean Preview Uplink) ---
    else {
      console.group(`[SINGLE PUT] ${typeLabel}`);
      window.UploadModalManager.writeLog(
        `STREAMING: Sending preview via PUT...`,
      );

      // Динамічно збираємо заголовки, які БЕКЕНД встиг зашити в підпис URL
      const dynamicHeaders = {};
      try {
        const urlObj = new URL(targetUrl);
        const signedHeadersStr =
          urlObj.searchParams.get("X-Amz-SignedHeaders") || "";

        if (signedHeadersStr) {
          const signedHeaders = signedHeadersStr.split(";");

          // 1. Обов'язково додаємо Content-Type, якщо він є в підписі
          if (signedHeaders.includes("content-type")) {
            dynamicHeaders["Content-Type"] = "application/zip";
          }

          // 2. Якщо бек підписав Storage Class — фронт зобов'язаний його передати
          if (signedHeaders.includes("x-amz-storage-class")) {
            dynamicHeaders["X-Amz-Storage-Class"] =
              uploadMeta.storage_class || "STANDARD";
          }

          // 3. Якщо бек все ще підписує метадані (про всяк випадок, якщо забув прибрати на беку)
          if (signedHeaders.includes("x-amz-meta-is-encrypted")) {
            dynamicHeaders["X-Amz-Meta-Is-Encrypted"] = String(
              uploadMeta.is_encrypted !== undefined
                ? uploadMeta.is_encrypted
                : "false",
            );
          }
          if (signedHeaders.includes("x-amz-meta-password-hint")) {
            // Захист від порожнього рядка, який ламає підпис
            dynamicHeaders["X-Amz-Meta-Password-Hint"] = String(
              uploadMeta.password_hint || "none",
            );
          }
          if (signedHeaders.includes("x-amz-meta-file-count")) {
            dynamicHeaders["X-Amz-Meta-File-Count"] = String(
              uploadMeta.file_count || "0",
            );
          }
        }
      } catch (pErr) {
        console.error("Failed to parse signed headers from URL", pErr);
      }

      console.log(
        `Sending PUT with dynamic headers based on signature:`,
        dynamicHeaders,
      );

      try {
        // Для AWS S3 регістр літер неважливий, але для Cloudflare R2 краще
        // привести ключі до нижнього регістру, якщо вони підписані як x-amz-*
        const normalizedHeaders = {};
        Object.keys(dynamicHeaders).forEach((key) => {
          normalizedHeaders[key.toLowerCase()] = dynamicHeaders[key];
        });
        // Зберігаємо правильний Content-Type
        if (dynamicHeaders["Content-Type"])
          normalizedHeaders["Content-Type"] = "application/zip";

        const response = await axios.put(targetUrl, file, {
          headers: normalizedHeaders,
          onUploadProgress: (e) => {
            const percent = Math.round((e.loaded * 100) / e.total);
            window.UploadModalManager.updateProgress(
              percent,
              "uploading_stream",
            );
          },
        });

        const etag = response.headers["etag"] || response.headers["ETag"];
        const cleanEtag = etag ? etag.replace(/"/g, "") : null;

        console.groupEnd();
        window.UploadModalManager.writeLog(
          `${typeLabel} uploaded successfully via Single PUT.`,
          "success",
        );

        return { 1: cleanEtag };
      } catch (err) {
        console.groupEnd();
        throw err;
      }
    }
  }

  /**
   * Parallel package assembler coordinator.
   */
  const buildPackages = async (files) => {
    const password = window.vaultEncryptionPassword;
    const tasks = [];

    // Evaluate Original Archives Pipeline Task Allocation
    const isUploadingOriginals = getEl("upload-originals-checkbox")?.checked;
    if (isUploadingOriginals) {
      tasks.push(
        createZipArchive(
          files,
          getArchiveName(),
          TMP_ARCHIVE_FILENAME,
          password,
        ),
      );
    } else {
      tasks.push(Promise.resolve(null));
    }

    // Evaluate Preview Proxies Pipeline Task Allocation
    const isPreviewEnabled = getEl("enable-preview")?.checked;
    if (isPreviewEnabled) {
      const generateAndZipPreview = async () => {
        const previewContent = await generatePreviewContent(files);
        return await createZipArchive(
          previewContent,
          `preview_${getArchiveName()}`,
          TMP_PREVIEW_FILENAME,
          password,
        );
      };
      tasks.push(generateAndZipPreview());
    } else {
      tasks.push(Promise.resolve(null));
    }

    const [archiveFile, previewFile] = await Promise.all(tasks);
    return { archiveFile, previewFile };
  };

  // --- 4. ENGINE ORCHESTRATOR (MAIN PROCESS EXECUTION FLOW) ---
  async function startExecution() {
    const files = window.fileQueue || [];
    if (files.length === 0) {
      return window.UploadModalManager.writeLog("Queue is empty", "warn");
    }

    window.UploadModalManager.open();
    window.UploadModalManager.setPackingState();
    window.UploadModalManager.writeLog(
      "Starting local sandboxed compilation...",
    );

    const btn = getEl("start-upload-btn");
    const storageClass = getEl("storage-class")?.value || "DEEP_ARCHIVE";

    try {
      btn.disabled = true;
      window.isProcessing = true;

      // Pipeline Stage 1: Build Local Binary Archives via OPFS
      const { archiveFile, previewFile } = await buildPackages(files);
      const params = new URLSearchParams(window.location.search);
      const collectionId = params.get("collectionId");

      // Pipeline Stage 2: Register Upload Transactions on Server Backend
      const payload = {
        collection_id: collectionId,
        archive: archiveFile
          ? {
              archive_name: archiveFile.name,
              archive_size_kb: toKB(archiveFile.size),
              archive_part_count: getPartCount(archiveFile.size),
              file_count: files.length,
              storage_class: storageClass,
              chunk_size_kb: toKB(API.CHUNK_SIZE),
              is_encrypted: !!window.vaultEncryptionPassword,
              password_hint: window.vaultPasswordHint,
            }
          : null,
        preview: previewFile
          ? {
              preview_name: previewFile.name,
              preview_size_kb: toKB(previewFile.size),
              preview_part_count: getPartCount(previewFile.size),
              file_count: files.length,
              storage_class:
                storageClass === "STANDARD" ? "STANDARD" : "GLACIER_IR",
              chunk_size_kb: toKB(API.CHUNK_SIZE),
              is_encrypted: !!window.vaultEncryptionPassword,
              password_hint: window.vaultPasswordHint,
            }
          : null,
      };

      const initData = await window.requester("POST", API.INIT, payload);
      if (initData.status !== "Ok") throw new Error(initData.message);

      // Pipeline Stage 3: Direct Core Binary Streaming to Storage Destinations
      state.totalBytes = (archiveFile?.size || 0) + (previewFile?.size || 0);
      const uploadTasks = [];
      let archivePartsMap = {};
      let previewPartsMap = {};

      if (previewFile && initData.preview) {
        window.UploadModalManager.writeLog(
          "Processing preview transmission...",
        );
        const previewTask = uploadToS3(
          initData.preview,
          previewFile,
          "PREVIEW",
        ).then((hashesMap) => {
          previewPartsMap = hashesMap;
        });
        uploadTasks.push(previewTask);
      }

      if (archiveFile && initData.archive) {
        window.UploadModalManager.writeLog(
          `Processing archive transmission...`,
        );
        const archiveTask = uploadToS3(
          initData.archive,
          archiveFile,
          "ARCHIVE",
        ).then((hashesMap) => {
          archivePartsMap = hashesMap;
        });
        uploadTasks.push(archiveTask);
      }

      // Synchronize parallel upload tasks resolution
      await Promise.all(uploadTasks);

      // Pipeline Stage 4: Commit Integrity Checksums to Finalize Storage Lifecycle
      window.UploadModalManager.writeLog(
        "Finalizing checksums and committing payload...",
        "info",
      );

      const confirmPayload = {
        uuid: initData.uuid,
        archive_hashes: archivePartsMap,
        preview_hashes: previewPartsMap,
      };

      await window.requester("POST", API.CONFIRM, confirmPayload);

      UploadModalManager.updateProgress(100, "sync_complete");
      UploadModalManager.writeLog(
        "Payload committed. Integrity hashes verified successfully.",
      );
      UploadModalManager.setSuccessState();

      window.fileQueue = [];
      if (window.renderTable) window.renderTable();
    } catch (err) {
      console.error(err);
      window.UploadModalManager.writeLog(
        `CRITICAL_FAILURE: ${err.message}`,
        "error",
      );

      // Null-safe evaluation for axios/server-side validation messages
      if (err?.response?.data?.message) {
        window.UploadModalManager.writeLog(
          `CRITICAL_FAILURE: ${err.response.data.message}`,
          "error",
        );
      }
    } finally {
      btn.disabled = false;
      window.isProcessing = false;
    }
  }

  // --- INITIALIZATION INTERFACE ATTACHMENT ---
  document.addEventListener("DOMContentLoaded", () => {
    getEl("start-upload-btn")?.addEventListener("click", startExecution);
  });
})();
