// One pack per supported architecture, referenced by the upstream v0.5.5 model
// matrix. The downloader resolves file size and SHA-256 at the immutable Hub commit.
export const BASALT_PACKS = [
  {
    repo: "Qwen3.8-Flash-Next-Basalt", revision: "fc721830e519ab52012d372e89b90d9a7df30ff2",
    file: "Qwen3.8-FN-NVFP4-DQ6_K.basalt", name: "Qwen3.8 Flash Next", quantization: "NVFP4 DQ6_K", sizeBytes: 131681979197,
  },
  {
    repo: "DeepSeek-V4.1-Flash-1017-Basalt", revision: "621661e913cb76e363bf14235667d3b5c0f787d4",
    file: "DeepSeek-V4.1-Flash-1017-UD-IQ1_M.basalt", name: "DeepSeek V4.1 Flash", quantization: "UD-IQ1_M", sizeBytes: 259973824987,
  },
  {
    repo: "Qwen3.8-27B-Basalt", revision: "10c9a90e0bf9e0809c37ae439c735647b835b74e",
    file: "Qwen3.8-27B-QUASAR-NVFP4.basalt", name: "Qwen3.8 27B", quantization: "QUASAR NVFP4", sizeBytes: 21149505930,
  },
  {
    repo: "Hy4-flash-Basalt", revision: "598f2ceedba9e1e5821dcb1c83e8530707069928",
    file: "Hy4-flash-NVFP4.basalt", name: "Hy4 Flash", quantization: "NVFP4", sizeBytes: 158746168309,
  },
  {
    repo: "Inkling-2-Mini-Basalt", revision: "426fea7456c37c102be8a30d16e4f6bf0dcd892d",
    file: "Inkling-2-Mini-NVFP4-q8.basalt", name: "Inkling 2 Mini", quantization: "NVFP4 Q8", sizeBytes: 19734300551,
  },
] as const;
