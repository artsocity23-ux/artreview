// Real clipboard check for the "copy video with notes" path (Windows): `node test/clipboard.test.js`.
// Puts a stand-in "video" file on the clipboard the way ar:copy-video does, reads it back with Get-Clipboard,
// then restores whatever text the user had on the clipboard before. Exits 1 on any failure.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { copyVideo } = require('../clipboard');

if (process.platform !== 'win32') {
  console.log('skip: this check reads the clipboard with Windows PowerShell');
  process.exit(0);
}

// Output goes through base64 of UTF-8, because the console code page would mangle Ukrainian text.
function ps(script, env = {}) {
  const wrapped = `& { ${script} } | ForEach-Object { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_)) }`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', wrapped],
    { env: { ...process.env, ...env }, windowsHide: true, encoding: 'utf8' });
  return out.split(/\r?\n/).filter(Boolean).map(l => Buffer.from(l.trim(), 'base64').toString('utf8'));
}

const readText = () => ps('Get-Clipboard -Raw').join('\n');
const readFiles = () => ps('Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }');
const readDropEffect = () => ps("Add-Type -AssemblyName System.Windows.Forms; $s = [System.Windows.Forms.Clipboard]::GetData('Preferred DropEffect'); if ($s) { $s.ReadByte() }")[0];

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, 'test-tmp');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

(async () => {
  const saved = readText();
  const createdTmp = !fs.existsSync(TMP);
  try {
    fs.mkdirSync(TMP, { recursive: true });
    // Spaces, Cyrillic and quotes in the name: none of it may break the PowerShell call.
    const file = path.join(TMP, "шот 010 'v2' \"final\" $x.mp4".replace(/"/g, ''));
    fs.writeFileSync(file, 'not a real video, only a file for the clipboard test\n');
    const text = 'shot_010.mp4 — 2 нотатки\n1. 00:00:00:12 (кадр 13–85) — Тінь темніша\n2. Прибрати відблиск на склі; $env:PATH `n "лапки"';

    const r1 = await copyVideo(file, text);
    check('copyVideo(file, text) ok', r1.ok && r1.withText, JSON.stringify(r1));
    const files1 = readFiles();
    check('FileDropList = the file', files1.length === 1 && files1[0] === file, JSON.stringify(files1));
    const text1 = readText().replace(/\r\n/g, '\n');
    check('text = the notes text', text1 === text, JSON.stringify(text1.slice(0, 60)));
    check('Preferred DropEffect = copy', readDropEffect() === '1');

    const r2 = await copyVideo(file, null);
    check('copyVideo(file, null) ok, no text', r2.ok && !r2.withText, JSON.stringify(r2));
    const files2 = readFiles();
    check('FileDropList after file-only copy', files2.length === 1 && files2[0] === file, JSON.stringify(files2));
    check('no text after file-only copy', readText() === '');

    const r3 = await copyVideo(path.join(TMP, 'missing.mp4'), 'x');
    check('missing file -> ok:false', !r3.ok);
  } catch (err) {
    check('no exception', false, err.stack || String(err));
  } finally {
    // Restore the user's text (or leave the clipboard empty if there was none).
    ps(saved
      ? "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetText($env:AR_RESTORE, [System.Windows.Forms.TextDataFormat]::UnicodeText)"
      : 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::Clear()', { AR_RESTORE: saved });
    check('clipboard text restored', readText() === saved);
    if (createdTmp) fs.rmSync(TMP, { recursive: true, force: true });
  }
  const failed = results.filter(r => !r.ok).length;
  console.log(failed ? `${failed} check(s) failed` : 'all clipboard checks passed');
  process.exit(failed ? 1 : 0);
})();
