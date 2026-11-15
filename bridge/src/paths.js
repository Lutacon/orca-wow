// Where the bridge keeps its files, per platform.
//
// Linux and macOS follow the XDG layout (~/.config, ~/.local/state, ~/.local/share).
// Windows keeps everything under %LOCALAPPDATA%\<app>: config, state and the installed
// copy of the bridge and addon.

import os from 'node:os';
import path from 'node:path';

export const APP = 'orca-wow';
export const WINDOWS = process.platform === 'win32';
// What the bridge calls the computer it runs on, in game and in its messages.
export const THIS_COMPUTER = process.platform === 'darwin' ? 'this Mac' : 'this PC';
export const THIS_COMPUTER_UC = THIS_COMPUTER[0].toUpperCase() + THIS_COMPUTER.slice(1);

const home = os.homedir();
const localAppData = () => process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
const xdg = (envVar, fallback) => path.join(process.env[envVar] || path.join(home, fallback), APP);

export const CONFIG_DIR = WINDOWS ? path.join(localAppData(), APP, 'config') : xdg('XDG_CONFIG_HOME', '.config');
export const STATE_DIR = WINDOWS ? path.join(localAppData(), APP, 'state') : xdg('XDG_STATE_HOME', '.local/state');
export const DATA_DIR = WINDOWS ? path.join(localAppData(), APP, 'app') : xdg('XDG_DATA_HOME', '.local/share');
