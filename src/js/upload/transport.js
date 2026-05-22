(function () {
  "use strict";

  const tmp_preview_file_name = "tmp_preview.zip";
  const tmp_archive_file_name = "tmp_archive.zip";

  const API = {
    INIT: "/api/storage/initiate-upload/",
    CONFIRM: "/api/storage/confirm-upload/",
    CHUNK_SIZE: 5000 * 1024 * 1024,
  };

  const { createFFmpeg, fetchFile } = FFmpeg;
  const ffmpeg = createFFmpeg({ log: false });
  let ffmpegLoaded = false;
  window.isProcessing = false;

  async function initFFmpeg() {
    if (!ffmpegLoaded) {
      await ffmpeg.load();
      ffmpegLoaded = true;
    }
  }

  let state = {
    totalBytes: 0,
    uploadedMap: new Map(),
    isAnimating: false,
  };

  // --- 1. ДОПОМІЖНІ ФУНКЦІЇ (HELPERS) ---
  const getEl = (id) => document.getElementById(id);
  const toKB = (bytes) => Math.round(bytes / 1024);
  const getPartCount = (size) => 1;

  function getArchiveName() {
    const input = getEl("archive-name-input");
    let name = input?.value.trim();
    if (!name) {
      const now = new Date();
      name = `vault_${now.toISOString().split("T")[0]}_${now.getHours()}-${now.getMinutes()}`;
    }
    return name.endsWith(".zip") ? name : name + ".zip";
  }

  /**
   * Universal function to create a ZIP archive (plain or encrypted).
   * @param {Array} files - Array of File objects or objects with {name, data}.
   * @param {string} filename - Output filename.
   * @param {string|null} password - Optional password for AES-256 encryption.
   * @returns {Promise<File>}
   */
  async function createZipArchive(
    files,
    filename,
    tmp_filename = "tmp_file.zip",
    password = null,
  ) {
    // 1. Доступ до OPFS
    const root = await navigator.storage.getDirectory();

    // Очищення старого файлу
    try {
      await root.removeEntry(tmp_filename);
    } catch (e) {}

    const tempFileHandle = await root.getFileHandle(tmp_filename, {
      create: true,
    });

    // 2. Створюємо WritableStream
    const writableStream = await tempFileHandle.createWritable();

    const zipConfig = { bufferedWrite: true };

    window.UploadModalManager.updateProgress(0, "packing_payload");

    // 1. Рахуємо загальний розмір усіх файлів для плавного прогресу
    const totalBytes = files.reduce((acc, file) => {
      const data = file.data !== undefined ? file.data : file;
      return acc + (data.size || 0);
    }, 0);

    let bytesProcessedSoFar = 0;

    if (password && password.trim() !== "") {
      zipConfig.password = password.trim();
      zipConfig.zipCrypto = false; // AES-256

      window.UploadModalManager.writeLog(
        `SECURE_UPLINK: Encrypting vault with AES-256 (OPFS Mode)...`,
      );
    }

    // Використовуємо наш стрім-врайтер замість BlobWriter
    const zipWriter = new zip.ZipWriter(writableStream, zipConfig);
    try {
      let currentFileIndex = 0;
      const totalFilesCount = files.length;

      for (const file of files) {
        currentFileIndex++;

        // 1. Визначаємо правильний шлях всередині архіву
        const data = file.data !== undefined ? file.data : file;
        const name = file.name;
        const archivePath = file.archivePath || name; // Пріоритет для шляху папки
        const fileSize = data.size || 0;

        const blobReader = new zip.BlobReader(
          data instanceof Blob ? data : new Blob([data]),
        );

        // Логуємо відносний шлях, щоб користувач бачив структуру папок у терміналі
        window.UploadModalManager.writeLog(
          `PACKING: [${currentFileIndex}/${totalFilesCount}] ${archivePath}...`,
        );

        // 2. Передаємо archivePath замість name. zip.js сам побудує дерево каталогів!
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

      // 4. Отримуємо готовий файл з диска
      const finalFile = await tempFileHandle.getFile();

      window.UploadModalManager.writeLog(`SUCCESS: Archive ready on disk.`);

      return new File([finalFile], filename, { type: "application/zip" });
    } catch (error) {
      window.UploadModalManager.writeLog(
        `CRITICAL_ERROR: OPFS Archiving failed!`,
      );
      console.error(`[Archive] Error:`, error);
      throw error;
    } finally {
      console.log('done')
    }
    }
  }
  /**
   * Processes files and generates preview content (thumbs, clips, or markers).
   * Returns an array of { name, data } objects.
   */
  async function generatePreviewContent(files) {
    const previewFiles = [];
    const maxWidth = parseInt(
      document.getElementById("preview-size-input")?.value || 800,
    );
    const quality =
      parseInt(document.getElementById("preview-quality-input")?.value || 75) /
      100;
    const isUploadingOriginals =
      document.getElementById("upload-originals-checkbox")?.checked ?? true;

    for (const file of files) {
      const originalPath = file.archivePath || file.name;
      const lastSlashIndex = originalPath.lastIndexOf("/");
      const dirPath =
        lastSlashIndex !== -1
          ? originalPath.substring(0, lastSlashIndex + 1)
          : "";

      try {
        // 1. IMAGES
        if (file.type.startsWith("image/")) {
          const options = {
            maxWidthOrHeight: maxWidth,
            initialQuality: quality,
            useWebWorker: true,
            fileType: "image/jpeg",
          };
          const thumb = await window.imageCompression(file, options);

          const newName = `thumb_${file.name}.jpg`;
          previewFiles.push({
            name: newName,
            archivePath: dirPath + newName, // Зберігаємо структуру папок!
            data: thumb,
          });
        }
        // 2. VIDEO
        else if (file.type.startsWith("video/")) {
          window.UploadModalManager.writeLog(
            `Processing video preview: ${file.name}...`,
            "info",
          );
          await initFFmpeg();
          ffmpeg.FS("writeFile", "temp_input", await fetchFile(file));
          await ffmpeg.run(
            "-t",
            "10",
            "-i",
            "temp_input",
            "-vf",
            "scale=-2:360,eq=saturation=1.2",
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
            archivePath: dirPath + newName, // Зберігаємо структуру папок!
            data: data.buffer,
          });

          ffmpeg.FS("unlink", "temp_input");
          ffmpeg.FS("unlink", "fast_preview.mp4");
        }
        // 3. TEXT
        else if (file.type === "text/plain" || file.name.endsWith(".log")) {
          const text = await file.text();
          const newName = `meta_${file.name}`;
          previewFiles.push({
            name: newName,
            archivePath: dirPath + newName, // Зберігаємо структуру папок!
            data: text,
          });
        }
        // 4. OTHERS / MARKERS
        else {
          if (!isUploadingOriginals) {
            previewFiles.push({
              name: file.name,
              archivePath: originalPath, // Залишаємо оригінальний шлях
              data: file,
            });
          } else {
            previewFiles.push({
              name: file.name,
              archivePath: originalPath, // Маркер лежить за тим же шляхом, що й оригінал
              data: "",
            });
          }
        }
      } catch (e) {
        window.UploadModalManager.writeLog(
          `Failed preview for: ${file.name}`,
          "warn",
        );
        previewFiles.push({
          name: file.name,
          archivePath: originalPath, // Фолбек-маркер теж кладемо на своє місце
          data: "",
        });
        console.error(e);
      }
    }
    return previewFiles;
  }

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

  async function uploadToS3(target, fields, file, typeLabel) {
    window.UploadModalManager.updateProgress(0, "uploading_stream");

    const formData = new FormData();

    // 1. Формуємо поля та логуємо їх
    console.group(`[DEBUG] FormData Fields`);
    Object.keys(fields).forEach((key) => {
      const value = fields[key] || file.type;
      formData.append(key, value);
    });

    // 2. Визначаємо правильне ім'я для S3
    // S3 POST вимагає, щоб файл був останнім полем
    const s3Key = fields["key"] || "unknown_file";
    const originalName = s3Key.split("/").pop();
    formData.append("file", file, originalName);
    console.groupEnd();

    try {
      console.log(`[DEBUG] Sending Axios POST request...`);

      const response = await axios.post(target, formData, {
        onUploadProgress: (e) => {
          const percent = Math.round((e.loaded * 100) / e.total);
          window.UploadModalManager.updateProgress(percent, "uploading_stream");
        },
        // ВАЖЛИВО: для POST Policy НЕ ставимо manual Content-Type
        // Браузер має сам виставити multipart/form-data з boundary
      });

      console.log(`[DEBUG] Response received:`, response.status);
      console.log(`[DEBUG] Response Headers:`, response.headers);

      const etag = response.headers["etag"] || response.headers["ETag"];
      const cleanEtag = etag ? etag.replace(/"/g, "") : null;
      window.UploadModalManager.writeLog(
        `${typeLabel} uploaded. Hash: ${cleanEtag}`,
        "success",
      );

      return cleanEtag;
    } catch (err) {
      console.group(`[DEBUG] Upload Error`);
      console.error(`Status: ${err.response?.status}`);
      console.error(`Error Code: ${err.code}`);

      if (err.response?.data) {
        console.error(`Server Response Data:`, err.response.data);
        // Спробуємо розпарсити XML помилку, якщо вона є
        const reader = new FileReader();
        reader.onload = () => console.warn("Parsed XML Error:", reader.result);
        if (err.response.data instanceof Blob) {
          reader.readAsText(err.response.data);
        }
      }
      console.groupEnd();

      window.UploadModalManager.writeLog(
        `Upload failed: ${typeLabel}`,
        "error",
      );
      throw err;
    }
  }

  // Step 1: Prepare and Build Packages
  const buildPackages = async (files) => {
    const password = window.vaultEncryptionPassword; // Accessing our global variable

    // 1. Prepare Archive Tasks
    const tasks = [];

    // 2. Main Archive Task (Originals)
    const isUploadingOriginals = document.getElementById(
      "upload-originals-checkbox",
    )?.checked;
    if (isUploadingOriginals) {
      tasks.push(
        createZipArchive(
          files,
          getArchiveName(),
          tmp_archive_file_name,
          password,
        ),
      );
    } else {
      tasks.push(Promise.resolve(null));
    }

    // 3. Preview Archive Task
    const isPreviewEnabled = document.getElementById("enable-preview")?.checked;
    if (isPreviewEnabled) {
      // First generate content, then zip it
      const generateAndZipPreview = async () => {
        const previewContent = await generatePreviewContent(files);
        return await createZipArchive(
          previewContent,
          `preview_${getArchiveName()}`,
          tmp_preview_file_name,
          password,
        );
      };
      tasks.push(generateAndZipPreview());
    } else {
      tasks.push(Promise.resolve(null));
    }

    // 4. Run building in parallel
    const [archiveFile, previewFile] = await Promise.all(tasks);

    return { archiveFile, previewFile };
  };

  // --- 4. ОРКЕСТРАТОР (MAIN FLOW) ---
  async function startExecution() {
    const files = window.fileQueue || [];
    if (files.length === 0)
      return window.UploadModalManager.writeLog("Queue is empty", "warn");

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
      state.uploadedMap.clear();

      // Етап 1: Побудова пакетів
      const { archiveFile, previewFile } = await buildPackages(files);
      const params = new URLSearchParams(window.location.search);
      const collectionId = params.get("collectionId");
      console.log("storageClass", storageClass);
      // Етап 2: Реєстрація на бекенді
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
              storage_class: "GLACIER_IR",
              chunk_size_kb: toKB(API.CHUNK_SIZE),
              is_encrypted: !!window.vaultEncryptionPassword,
              password_hint: window.vaultPasswordHint,
            }
          : null,
      };

      const initData = await window.requester("POST", API.INIT, payload);
      if (initData.status !== "Ok") throw new Error(initData.message);

      // Етап 3: Завантаження
      state.totalBytes = (archiveFile?.size || 0) + (previewFile?.size || 0);
      const uploadTasks = [];
      let archiveEtag = null;
      let previewEtag = null;

      // 1. Створюємо чергу завдань
      if (previewFile && initData.preview) {
        window.UploadModalManager.writeLog(
          "Streaming PREVIEWS to GLACIER_IR...",
        );
        const previewTask = uploadToS3(
          initData.preview.url,
          initData.preview.fields,
          previewFile,
          "PREVIEW",
        ).then((etag) => {
          previewEtag = etag;
        }); // Зберігаємо хеш після завершення

        uploadTasks.push(previewTask);
      }

      if (archiveFile && initData.archive) {
        window.UploadModalManager.writeLog(
          `Streaming ARCHIVE to ${storageClass}...`,
        );
        const archiveTask = uploadToS3(
          initData.archive.url,
          initData.archive.fields,
          archiveFile,
          "ARCHIVE",
        ).then((etag) => {
          archiveEtag = etag;
        }); // Зберігаємо хеш після завершення

        uploadTasks.push(archiveTask);
      }

      // 2. Чекаємо на завершення всіх завантажень
      // Якщо будь-яке завантаження впаде, Promise.all викине помилку,
      // яку обробить зовнішній try/catch
      await Promise.all(uploadTasks);

      // 3. Відправляємо підтвердження на бекенд
      window.UploadModalManager.writeLog(
        "Finalizing upload and verifying integrity...",
        "info",
      );
      // Етап 4: Підтвердження
      window.UploadModalManager.writeLog("Finalizing checksums...");

      const confirmPayload = {
        uuid: initData.uuid,
        archive_hashes: {},
        preview_hashes: {},
      };

      // 2. Додаємо дані лише якщо вони існують
      if (archiveEtag) {
        confirmPayload.archive_hashes[1] = archiveEtag;
      }

      if (previewEtag) {
        confirmPayload.preview_hashes[1] = previewEtag;
      }

      await window.requester("POST", API.CONFIRM, confirmPayload);

      UploadModalManager.updateProgress(100, "sync_complete");
      UploadModalManager.writeLog(
        "Payload committed. Integrity hashes verified successfully.",
      );
      UploadModalManager.setSuccessState();
      window.fileQueue = [];
      if (window.renderTable) window.renderTable();
    } catch (err) {
      window.UploadModalManager.writeLog(
        `CRITICAL_FAILURE: ${err.message}`,
        "error",
      );
      console.error(err);
    } finally {
      btn.disabled = false;
      window.isProcessing = false;
    }
  }

  // --- ІНІЦІАЛІЗАЦІЯ ---
  document.addEventListener("DOMContentLoaded", () => {
    getEl("start-upload-btn")?.addEventListener("click", startExecution);
  });
})();
