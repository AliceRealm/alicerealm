"""Exercise PowerShell stable-channel fallback without installing software."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class WindowsReleaseLane(unittest.TestCase):
    def test_version_channel_fallback_is_404_only(self):
        shell = shutil.which('powershell') or shutil.which('pwsh')
        if not shell:
            self.skipTest('PowerShell required')
        source = (ROOT / 'static/install.ps1').read_text(encoding='utf-8')
        function = source[source.index('function Get-VersionPointer {'):source.index('function Install-Cli {')]
        fixture = function + '''
class ReleaseLaneHttpException : System.Exception {
 [object]$Response
 ReleaseLaneHttpException([int]$code) : base('HTTP failure') {
  $this.Response = [pscustomobject]@{StatusCode=$code}
 }
}
$script:calls = @()
function Invoke-RestMethod {
 param($Uri, $TimeoutSec)
 $script:calls += $Uri
 if ($Uri -like '*/cli/windows/latest/version.txt') {
  switch ($env:MODE) {
   windows_ok { return '1.0.31' }
   windows_malformed { return '<html>' }
   windows_network_error { throw 'network error' }
   windows_server_error { throw [ReleaseLaneHttpException]::new(503) }
   default { throw [ReleaseLaneHttpException]::new(404) }
  }
 }
 if ($Uri -like '*/cli/v2/latest/version.txt') {
  switch ($env:MODE) {
   v2_ok { return '1.0.6' }
   v2_malformed { return '<html>' }
   v2_network_error { throw 'network error' }
   v2_server_error { throw [ReleaseLaneHttpException]::new(503) }
   default {
    throw [ReleaseLaneHttpException]::new(404)
   }
  }
 }
 return '1.0.5'
}
$CdnUrl = 'https://cdn.invalid'
try { $value=Get-LatestCliVersion; Write-Output "VALUE=$value" } catch { Write-Output 'FAILED' }
Write-Output "CALLS=$($script:calls.Count)"
'''
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'fixture.ps1'
            path.write_text(fixture, encoding='utf-8-sig')
            cases = [
                ('windows_ok', '1.0.31', 1),
                ('v2_ok', '1.0.6', 2),
                ('all_absent', '1.0.5', 3),
                ('windows_server_error', None, 1),
                ('windows_network_error', None, 1),
                ('windows_malformed', None, 1),
                ('v2_server_error', None, 2),
                ('v2_network_error', None, 2),
                ('v2_malformed', None, 2),
            ]
            for mode, expected, count in cases:
                with self.subTest(mode=mode):
                    result=subprocess.run([shell,'-NoProfile','-File',str(path)],env=dict(os.environ,MODE=mode),capture_output=True,text=True)
                    self.assertEqual(result.returncode,0,result.stderr)
                    self.assertIn(f'CALLS={count}',result.stdout)
                    self.assertIn(f'VALUE={expected}' if expected else 'FAILED',result.stdout)
