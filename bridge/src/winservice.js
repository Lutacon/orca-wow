// Windows: run the bridge at logon as a Task Scheduler task.
//
// It has to run in the user's interactive session (not as a service in session 0):
// the bridge reads the game's pixels from the desktop. `conhost --headless` keeps the
// console window from showing. The task runs a small .cmd script, because conhost
// re-quotes its arguments and breaks a cmd /c line that has quotes of its own (the
// bridge silently never started). conhost also always exits 0, so Task Scheduler can't
// see a crash: the script restarts the bridge itself, like systemd's Restart=always.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { APP, STATE_DIR } from './paths.js';

const TASK = APP;
const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// A quoted script path is the one cmd /c line conhost passes on intact.
export function taskArguments(scriptFile) {
  return `--headless cmd.exe /d /c "${scriptFile}"`;
}

// The batch file the task runs. A clean exit (code 0) ends it; a crash restarts the
// bridge after 30 seconds. % is doubled because batch files expand it.
export function taskScript(command, logFile) {
  const q = (s) => `"${String(s).replace(/%/g, '%%')}"`;
  return [
    '@echo off',
    'chcp 65001 >nul',
    ':run',
    `${command.map(q).join(' ')} >> ${q(logFile)} 2>&1`,
    'if not errorlevel 1 exit /b 0',
    `echo The bridge stopped with an error; restarting in 30 seconds. >> ${q(logFile)}`,
    'ping -n 31 127.0.0.1 >nul',
    'goto run',
    '',
  ].join('\r\n');
}

export function taskXml(scriptFile) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Bridge between World of Warcraft: Forever and coding agents (${xml(APP)})</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(currentUser())}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(currentUser())}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(path.join(SYSTEM32, 'conhost.exe'))}</Command>
      <Arguments>${xml(taskArguments(scriptFile))}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

function currentUser() {
  const domain = process.env.USERDOMAIN;
  const user = process.env.USERNAME;
  return domain ? `${domain}\\${user}` : user;
}

function schtasks(args, { warn = true } = {}) {
  const r = spawnSync(path.join(SYSTEM32, 'schtasks.exe'), args, { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 && warn) process.stderr.write(r.stderr || r.stdout || `schtasks ${args.join(' ')} failed\n`);
  return r.status === 0;
}

// Same shape as the systemd and launchd helpers in bin/orca-wow.js.
export function windowsStartup(bridgeCommand) {
  return {
    name: TASK,
    kind: 'logon task',
    file: path.join(STATE_DIR, `${TASK}-task.xml`),
    script: path.join(STATE_DIR, `${TASK}-task.cmd`),
    install() {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(this.script, taskScript(bridgeCommand(), path.join(STATE_DIR, 'bridge.log')));
      const body = taskXml(this.script);
      // schtasks /XML wants UTF-16 with a byte order mark.
      fs.writeFileSync(this.file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, 'utf16le')]));
      schtasks(['/End', '/TN', TASK], { warn: false });
      if (!schtasks(['/Create', '/TN', TASK, '/XML', this.file, '/F'])) return false;
      return schtasks(['/Run', '/TN', TASK]);
    },
    restart() {
      schtasks(['/End', '/TN', TASK], { warn: false });
      schtasks(['/Run', '/TN', TASK]);
    },
    remove() {
      schtasks(['/End', '/TN', TASK], { warn: false });
      schtasks(['/Delete', '/TN', TASK, '/F'], { warn: false });
      fs.rmSync(this.file, { force: true });
      fs.rmSync(this.script, { force: true });
    },
  };
}
