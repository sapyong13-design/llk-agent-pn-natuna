import { existsSync } from 'node:fs';
import { join } from 'node:path';

const envBrowser = process.env.LLK_BROWSER_PATH || process.env.BROWSER_PATH || process.env.EDGE_PATH;
const home = process.env.HOME || process.env.USERPROFILE || '';

const platformCandidates = {
  win32: [
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
  ],
  darwin: [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    home && join(home, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome')
  ],
  linux: [
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ]
};

export const browserCandidates = [envBrowser, ...(platformCandidates[process.platform] || [])].filter(Boolean);
export const browserExecutable = () => browserCandidates.find(existsSync) || null;
export const browserLaunchOptions = () => {
  const executablePath = browserExecutable();
  if (!executablePath) throw new Error('Browser Chromium tidak ditemukan. Instal Microsoft Edge, Google Chrome, atau Chromium; atau atur LLK_BROWSER_PATH ke file executable browser.');
  return { executablePath };
};
