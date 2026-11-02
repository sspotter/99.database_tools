import { spawn } from 'node:child_process';

// Only the fixed program is an argument. Secret bytes travel through stdin.
const program = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
try {
  $request=[Console]::In.ReadToEnd() | ConvertFrom-Json
  $bytes=[Convert]::FromBase64String($request.value)
  $scope=[Security.Cryptography.DataProtectionScope]::CurrentUser
  if($request.operation -eq 'protect') {
    $protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,$scope)
  } else {
    $protected=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,$scope)
  }
  [Console]::Out.Write([Convert]::ToBase64String($protected))
} catch { exit 1 }
`;
const encodedProgram = Buffer.from(program, 'utf16le').toString('base64');

async function transform(operation, encodedSecret) {
  if (process.platform !== 'win32') throw new Error('Saved credentials require Windows DPAPI.');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedProgram
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let settled = false;
    function fail() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('Credentials unavailable; re-enter credentials.'));
    }
    const timer = setTimeout(() => { child.kill(); fail(); }, 15000);
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stderr.resume();
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.length > 65536) { child.kill(); fail(); }
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (settled) return;
      if (code !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(output)) return fail();
      settled = true;
      resolve(output);
    });
    child.stdin.end(JSON.stringify({ operation, value: encodedSecret }));
  });
}

export async function protectSecret(secret) {
  return transform('protect', Buffer.from(secret, 'utf8').toString('base64'));
}

export async function unprotectSecret(ciphertext) {
  return Buffer.from(await transform('unprotect', ciphertext), 'base64').toString('utf8');
}
