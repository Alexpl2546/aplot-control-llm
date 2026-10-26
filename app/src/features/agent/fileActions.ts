const EDITOR = new Set('c cpp cc h hpp cs go rs py pyw js mjs cjs ts tsx jsx java kt swift rb php ps1 sh bash bat cmd sql vue svelte scss sass'.split(' '));
const TEXT = new Set('txt md markdown log csv tsv json jsonl yaml yml toml ini cfg conf xml css tex'.split(' '));
const ASSOCIATED = new Set('html htm pdf doc docx odt rtf xls xlsx xlsm ods ppt pptx odp epub png jpg jpeg webp gif bmp ico avif svg tif tiff mp3 wav ogg flac m4a opus mp4 webm mkv avi mov zip 7z rar tar gz bz2 xz psd ai blend gltf glb obj stl fbx'.split(' '));
export function projectFileActions(path:string) {
  const extension=path.split(/[\\/]/).at(-1)?.split('.').slice(1).at(-1)?.toLowerCase()??'';
  const mode=EDITOR.has(extension)?'editor':TEXT.has(extension)||ASSOCIATED.has(extension)?'default':'reveal';
  return {mode,canPreview:EDITOR.has(extension)||TEXT.has(extension)||['html','htm','svg'].includes(extension),browser:['html','htm'].includes(extension)} as const;
}
