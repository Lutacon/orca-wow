// Windows: run the bridge at logon as a Task Scheduler task.
//
// It has to run in the user's interactive session (not as a service in session 0):
// the bridge reads the game's pixels from the desktop. `conhost --headless` keeps the
// console window from showing, and cmd.exe sends output to bridge.log. Task Scheduler
// restarts it when it exits with an error, like systemd's Restart=always.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { APP, STATE_DIR } from './paths.js';

const TASK = APP;
const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// cmd /c strips the first and last quote of a line that starts with one, so the whole
// command goes inside one more pair of quotes.
export function taskArguments(command, logFile) {
  const quoted = command.map((a) => `"${a}"`).join(' ');
  return `--headless cmd.exe /d /c "${quoted} >> "${logFile}" 2>&1"`;
}

export function taskXml(command, logFile) {
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
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(path.join(SYSTEM32, 'conhost.exe'))}</Command>
      <Arguments>${xml(taskArguments(command, logFile))}</Arguments>
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
    install() {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      const body = taskXml(bridgeCommand(), path.join(STATE_DIR, 'bridge.log'));
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
    },
  };
}
