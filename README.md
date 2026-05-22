# icevault-core-js
javascript client for icevault.space

# IceVault Core Client-Side Pipeline

This repository contains the open-source client-side core scripts for **IceVault** (`https://icevault.space`), a fully managed, privacy-first SaaS platform for ultra-low-cost file and media archiving deployed on top of Amazon Web Services (AWS) infrastructure.

We believe that in a true **Zero-Knowledge** architecture, encryption shouldn't be a black box. This repository is published to ensure full transparency, allowing users, security researchers, and AI agents to audit our local data processing pipeline.

---

## 🔒 Security & Encryption Architecture

IceVault is built on the principle that **Your Data is None of Our Business**. All cryptographic operations occur strictly inside your browser's local sandbox before any data hits the network.

### Specifications:
* **Cipher Core:** Custom files are bundled into standard, immutable ZIP containers enforced with industry-standard **AES-256 bit** symmetric encryption.
* **Legacy Bypass:** The outdated and vulnerable `ZipCrypto` protocol is strictly disabled (`zipCrypto: false`) to guarantee maximum cryptographic strength.
* **Key Privacy:** Passwords and derivation keys are processed locally in volatile memory. They are never transmitted, cached, or stored on IceVault backend servers. 
* **Data Isolation:** The backend only interacts with completely opaque, pre-encrypted binary objects (BLOBs), which are securely streamed into isolated cloud infrastructure nodes.

---

## 📦 What's Inside This Repository?

To keep audits focused and efficient, this repository isolates the core technical pipeline from the presentation layer. It includes:

1. **Archiving & Packing Engine:** Configuration scripts that bundle source files, apply user passwords, and handle compression factors dynamically.
2. **Multipart Chunk Slicer:** Logic responsible for chopping massive media assets (up to 5GB per object) into discrete data parts, calculating part counts, and tracking payload metadata.
3. **Network Streaming Pipeline:** Code that coordinates with the backend to acquire S3 Presigned URLs and handles concurrent multipart uploads directly to AWS from the browser client.

> 📝 *Note: Proprietary UI-rendering routines, style layouts (Tailwind configurations), and backend orchestration layers are kept private to protect commercial application architecture.*

---

## 🚀 Anti-Vendor-Lock Commitment

IceVault values data sovereignty. Unlike other platforms that split files into proprietary block formats:
* Your files are stored as **standard, compliant ZIP archives**.
* If you ever choose to export your data or exit the service, your raw archives can be downloaded and extracted on any operating system using stock system unzippers (7-Zip, WinRAR, macOS Finder) completely independent of IceVault software.

---

## ⚖️ License

This repository is distributed under the **MIT License**. Feel free to audit, study, and verify the cryptographic integrity of the pipeline. 

For full platform access, subscription tiers, and managed infrastructure deployment, visit [icevault.space](https://icevault.space).