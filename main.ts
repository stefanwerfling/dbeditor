import 'normalize.css';
import './main.css';

import {DbEditor} from './DbEditor/DbEditor.js';

/*
 * `__APP_VERSION__` is substituted at transpile time by Vite (see
 * vite.config.ts > define). Painted into the topbar so the user can
 * see which release they're running without opening package.json.
 */
const versionEl = document.getElementById('topbar-version');
if (versionEl) {versionEl.textContent = `v${__APP_VERSION__}`;}

const editor = new DbEditor();
editor.init();