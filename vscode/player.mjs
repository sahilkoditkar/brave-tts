// Plays MP3 files with the operating system's own player (VS Code has no audio API).
// macOS: afplay (built in). Windows: PowerShell + Windows Media (built in).
// Linux: the first of ffplay / mpg123 / mpv that is installed.

import { spawn, spawnSync } from 'node:child_process';

function which(cmd) {
  return spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }).status === 0;
}

let command;
function resolveCommand() {
  if (command !== undefined) return command;
  if (process.platform === 'darwin') {
    command = (file) => ['afplay', [file]];
  } else if (process.platform === 'win32') {
    command = (file) => ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName PresentationCore; $p = New-Object System.Windows.Media.MediaPlayer; ' +
      `$p.Open([uri]'${file.replace(/'/g, "''")}'); $p.Play(); ` +
      'while (-not $p.NaturalDuration.HasTimeSpan) { Start-Sleep -Milliseconds 20 }; ' +
      'while ($p.Position -lt $p.NaturalDuration.TimeSpan) { Start-Sleep -Milliseconds 50 }; $p.Close()']];
  } else if (which('ffplay')) {
    command = (file) => ['ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', file]];
  } else if (which('mpg123')) {
    command = (file) => ['mpg123', ['-q', file]];
  } else if (which('mpv')) {
    command = (file) => ['mpv', ['--no-video', '--really-quiet', file]];
  } else {
    command = null;
  }
  return command;
}

// -> { started: Promise<number> (timestamp audio began), done: Promise<void>, stop() }
export function play(file) {
  const cmd = resolveCommand();
  if (!cmd) throw new Error('No audio player found. Install ffplay (ffmpeg), mpg123 or mpv.');
  const [bin, args] = cmd(file);
  const child = spawn(bin, args, { stdio: 'ignore', windowsHide: true });
  let stopped = false;
  const started = new Promise((resolve) => child.once('spawn', () => resolve(Date.now())));
  const done = new Promise((resolve, reject) => {
    child.once('error', (err) => reject(new Error(`Audio player failed: ${err.message}`)));
    child.once('exit', (code) => {
      if (stopped || code === 0) resolve();
      else reject(new Error(`Audio player exited with code ${code}`));
    });
  });
  return {
    started,
    done,
    stop() {
      stopped = true;
      child.kill();
    },
  };
}
