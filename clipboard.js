// Puts an exported video on the system clipboard as a file, so Ctrl+V in a messenger attaches it.
// Plain Node (no Electron) so test/clipboard.test.js can run it with `node`.
// The path and the text always travel through environment variables or argv, never inside a command string.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const { pathToFileURL } = require('url');

// Windows: a DataObject with the file drop list (what Explorer's Ctrl+C makes) plus the text, in one clipboard
// write, so Telegram gets the video and the caption together. Single quotes only: the script is one argv item.
const WIN_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Windows.Forms',
  '$data = New-Object System.Windows.Forms.DataObject',
  '$files = New-Object System.Collections.Specialized.StringCollection',
  '[void]$files.Add($env:AR_CLIP_FILE)',
  '$data.SetFileDropList($files)',
  // DROPEFFECT_COPY: paste must copy the file, never move it out of the export folder
  "$data.SetData('Preferred DropEffect', (New-Object System.IO.MemoryStream(,[byte[]](1, 0, 0, 0))))",
  "if ($env:AR_CLIP_HAS_TEXT -eq '1') { $data.SetText($env:AR_CLIP_TEXT, [System.Windows.Forms.TextDataFormat]::UnicodeText) }",
  // copy=true keeps the data after PowerShell exits; retries cover another app holding the clipboard
  '[System.Windows.Forms.Clipboard]::SetDataObject($data, $true, 10, 100)',
].join('; ');

function run(cmd, args, opts = {}) {
  return new Promise(resolve => {
    execFile(cmd, args, { windowsHide: true, timeout: 20000, ...opts }, (err, stdout, stderr) =>
      resolve({ ok: !err, error: err ? String(stderr || err.message).trim() : null }));
  });
}

function hasCommand(cmd) {
  return new Promise(resolve => {
    const p = spawn('sh', ['-c', 'command -v "$1"', 'sh', cmd], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('exit', code => resolve(code === 0));
  });
}

async function copyVideo(file, text) {
  if (!file || !fs.existsSync(file)) return { ok: false, withText: false, error: 'file not found' };
  const withText = typeof text === 'string' && text.length > 0;

  if (process.platform === 'win32') {
    const env = { ...process.env, AR_CLIP_FILE: file, AR_CLIP_HAS_TEXT: withText ? '1' : '0', AR_CLIP_TEXT: withText ? text : '' };
    const r = await run('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', WIN_SCRIPT], { env });
    return { ok: r.ok, withText: r.ok && withText, error: r.error };
  }

  if (process.platform === 'darwin') {
    // A file reference on the pasteboard; macOS cannot carry the text alongside it here, so the caller copies text apart.
    const r = await run('osascript', ['-e', 'on run argv', '-e', 'set the clipboard to (POSIX file (item 1 of argv))', '-e', 'end run', file]);
    return { ok: r.ok, withText: false, error: r.error };
  }

  if (!(await hasCommand('xclip'))) return { ok: false, withText: false, error: 'xclip not found' };
  return new Promise(resolve => {
    // xclip forks and keeps serving the selection after we close its stdin.
    const p = spawn('xclip', ['-selection', 'clipboard', '-t', 'text/uri-list'], { stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('error', err => resolve({ ok: false, withText: false, error: err.message }));
    p.on('exit', code => resolve({ ok: code === 0, withText: false, error: code === 0 ? null : `xclip exit ${code}` }));
    p.stdin.end(`${pathToFileURL(file).href}\r\n`);
  });
}

module.exports = { copyVideo };
