import { create } from 'zustand';
export const useLaunchUi = create<{
  quickAdd:boolean;
  preferredProfileId?:string;
  setQuickAdd:(open:boolean, profileId?:string)=>void;
}>(set=>({quickAdd:false,setQuickAdd:(quickAdd,preferredProfileId)=>set({quickAdd,preferredProfileId})}));
