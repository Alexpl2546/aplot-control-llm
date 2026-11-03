// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clipboardImages, readImageFile } from '../src/features/chat/clipboardImages';
import { messageMedia, chatAttachmentPayload } from '../src/features/chat/media';
import { MediaGallery } from '../src/features/chat/MediaGallery';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, args?: { name?: string }) => args?.name ? `${key}: ${args.name}` : key }) }));
beforeEach(() => {
  vi.clearAllMocks();
  URL.createObjectURL = vi.fn().mockReturnValue('blob:preview');
  URL.revokeObjectURL = vi.fn();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
afterEach(cleanup);

it('reads clipboard images from WebView items and does not duplicate the files representation', async () => {
  const file = new File(['image'], 'clipboard.png', { type: 'image/png' });
  const data = { files: [], items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] } as unknown as DataTransfer;
  expect(clipboardImages(data)).toEqual([file]);
  expect(clipboardImages({ ...data, files: [file] } as unknown as DataTransfer)).toEqual([file]);
  expect(await readImageFile(file)).toBe('data:image/png;base64,aW1hZ2U=');
  await expect(readImageFile(new File(['svg'], 'unsafe.svg', { type: 'image/svg+xml' }))).rejects.toThrow('attachment-unsupported');
});

it('opens image thumbnails inside a dialog and releases object URLs after closing', async () => {
  render(<MediaGallery items={[{ id: 'image', name: 'photo.png', kind: 'image', data: 'data:image/png;base64,AA==' }]}/>);
  fireEvent.click(screen.getByRole('button', { name: 'chat.media.open: photo.png' }));
  const dialog = await screen.findByRole('dialog');
  await waitFor(() => expect(dialog.querySelector('img')?.getAttribute('src')).toBe('blob:preview'));
  fireEvent.click(screen.getByRole('button', { name: 'actions.close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
});

it('loads an attached video only on opening and provides native playback controls', async () => {
  vi.mocked(invoke).mockResolvedValue({ data: 'data:video/mp4;base64,AA==' });
  render(<MediaGallery items={[{ id: 'video', name: 'clip.mp4', kind: 'video', path: 'C:/media/clip.mp4', poster: 'data:image/png;base64,AA==' }]}/>);
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'chat.media.open: clip.mp4' }));
  const dialog = await screen.findByRole('dialog');
  await waitFor(() => expect(dialog.querySelector('video')?.hasAttribute('controls')).toBe(true));
  expect(invoke).toHaveBeenCalledWith('chat_attachment_read', { path: 'C:/media/clip.mp4', preview: true });
});

it('reports missing videos inside the viewer and still allows closing it', async () => {
  vi.mocked(invoke).mockRejectedValue(new Error('attachment-missing'));
  render(<MediaGallery items={[{ id: 'missing', name: 'missing.mp4', kind: 'video', path: 'missing.mp4' }]}/>);
  fireEvent.click(screen.getByRole('button', { name: 'chat.media.open: missing.mp4' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'chat.media.previewFailed');
  fireEvent.click(screen.getByRole('button', { name: 'actions.close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('keeps video preview paths separate from the sampled frames sent to a model', () => {
  const items = [{ id: 'one', name: 'image.png', kind: 'image' as const, data: 'image-data' },
    { id: 'two', name: 'clip.mp4', kind: 'video' as const, path: 'C:/clip.mp4', frames: ['frame1', 'frame2', 'frame3', 'frame4'] }];
  expect(messageMedia(items)).toEqual([{ name: 'image.png', kind: 'image', imageIndex: 0 }, { name: 'clip.mp4', kind: 'video', imageIndex: 1, path: 'C:/clip.mp4' }]);
  expect(chatAttachmentPayload(items).images).toEqual(['image-data', 'frame1', 'frame2', 'frame3', 'frame4']);
});
