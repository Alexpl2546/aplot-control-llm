/** WebView2 sometimes exposes pasted images only through DataTransfer.items. */
export function clipboardImages(data: Pick<DataTransfer, 'files' | 'items'>): File[] {
  const files = Array.from(data.files ?? []).filter(file => file.type.startsWith('image/'));
  if (files.length) return files;
  return Array.from(data.items ?? []).filter(item => item.kind === 'file' && item.type.startsWith('image/'))
    .map(item => item.getAsFile()).filter((file): file is File => file !== null);
}

export function readImageFile(file: File): Promise<string> {
  if (file.size > 5 * 1024 * 1024) return Promise.reject(new Error('attachment-limit'));
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) return Promise.reject(new Error('attachment-unsupported'));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reader.onabort = () => reject(new Error('attachment-data'));
    reader.readAsDataURL(file);
  });
}
