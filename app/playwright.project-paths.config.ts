import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./e2e',testMatch:['project-paths.e2e.ts','project-removal.e2e.ts'],workers:1,reporter:'list',use:{baseURL:'http://127.0.0.1:1422',channel:'chrome',headless:true,trace:'retain-on-failure'},outputDir:'artifacts/project-paths/playwright-results'});
