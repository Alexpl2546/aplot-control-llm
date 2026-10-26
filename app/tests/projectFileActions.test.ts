import {describe,it,expect} from 'vitest';
import {projectFileActions} from '../src/features/agent/fileActions';
describe('project document actions',()=>{
  it('opens documents and media with their associated applications',()=>{
    for(const extension of ['pdf','docx','xlsx','pptx','png','mp3','mp4','zip'])expect(projectFileActions(`C:/project/file.${extension}`).mode).toBe('default');
    expect(projectFileActions('folder/PRESENTATION.HTML')).toMatchObject({mode:'default',browser:true,canPreview:true});
  });
  it('opens executable source as text and reveals unknown or executable files',()=>{
    for(const extension of ['js','py','ps1','bat','cmd','sh'])expect(projectFileActions(`file.${extension}`)).toMatchObject({mode:'editor',canPreview:true});
    for(const file of ['document.pdf.exe','unknown.binary','noextension'])expect(projectFileActions(file)).toMatchObject({mode:'reveal',canPreview:false});
  });
});
