const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

async function runPs(script, timeout = 10000) {
  const { stdout, stderr } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
  );
  if (stderr && !stdout) throw new Error(stderr.trim());
  return String(stdout || '').trim();
}

function psString(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

const bootstrap = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
$root = [System.Windows.Automation.AutomationElement]::RootElement
`;

async function uiSnapshot({ maxElements = 120, maxDepth = 5 } = {}) {
  maxElements = Math.max(20, Math.min(300, Number(maxElements) || 120));
  maxDepth = Math.max(1, Math.min(8, Number(maxDepth) || 5));
  const script = `${bootstrap}
$focused = [System.Windows.Automation.AutomationElement]::FocusedElement
if (-not $focused) { throw 'Brak aktywnego elementu UI.' }
$window = $focused
while ($window.Current.ControlType -ne [System.Windows.Automation.ControlType]::Window -and $window.Current.Parent) { $window = $window.Current.Parent }
if ($window.Current.ControlType -ne [System.Windows.Automation.ControlType]::Window) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $cursor = $focused
  while ($cursor) {
    if ($cursor.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window) { $window = $cursor; break }
    $cursor = $walker.GetParent($cursor)
  }
}
$items = New-Object System.Collections.Generic.List[object]
function Walk([System.Windows.Automation.AutomationElement]$el, [int]$depth) {
  if (-not $el -or $depth -gt ${maxDepth} -or $items.Count -ge ${maxElements}) { return }
  try {
    $r = $el.Current.BoundingRectangle
    $items.Add([pscustomobject]@{
      name = $el.Current.Name
      automationId = $el.Current.AutomationId
      type = $el.Current.ControlType.ProgrammaticName.Replace('ControlType.','')
      enabled = $el.Current.IsEnabled
      offscreen = $el.Current.IsOffscreen
      x = [math]::Round($r.X)
      y = [math]::Round($r.Y)
      width = [math]::Round($r.Width)
      height = [math]::Round($r.Height)
      depth = $depth
    })
  } catch {}
  $children = $el.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($child in $children) { if ($items.Count -ge ${maxElements}) { break }; Walk $child ($depth + 1) }
}
Walk $window 0
[pscustomobject]@{ window = $window.Current.Name; count = $items.Count; elements = $items } | ConvertTo-Json -Depth 7 -Compress
`;
  const raw = await runPs(script, 12000);
  return JSON.parse(raw);
}

async function uiFocusWindow({ title }) {
  if (!title) throw new Error('Brak tytułu okna.');
  const script = `${bootstrap}
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
$wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
$needle = ${psString(title)}
$target = $null
foreach ($w in $wins) { if ($w.Current.Name -like ('*' + $needle + '*')) { $target = $w; break } }
if (-not $target) { throw ('Nie znaleziono okna: ' + $needle) }
$target.SetFocus()
[pscustomobject]@{ ok=$true; window=$target.Current.Name } | ConvertTo-Json -Compress
`;
  return JSON.parse(await runPs(script));
}

function findElementScript(args = {}) {
  const name = psString(args.name || '');
  const automationId = psString(args.automationId || '');
  const controlType = psString(args.controlType || '');
  return `
$focused = [System.Windows.Automation.AutomationElement]::FocusedElement
if (-not $focused) { throw 'Brak aktywnego elementu UI.' }
$window = $focused
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$cursor = $focused
while ($cursor) {
  if ($cursor.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window) { $window = $cursor; break }
  $cursor = $walker.GetParent($cursor)
}
$needleName = ${name}; $needleId = ${automationId}; $needleType = ${controlType}
$all = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$target = $null
foreach ($el in $all) {
  $ok = $true
  if ($needleName) { $ok = $ok -and ($el.Current.Name -like ('*' + $needleName + '*')) }
  if ($needleId) { $ok = $ok -and ($el.Current.AutomationId -eq $needleId) }
  if ($needleType) { $ok = $ok -and ($el.Current.ControlType.ProgrammaticName.Replace('ControlType.','') -eq $needleType) }
  if ($ok -and -not $el.Current.IsOffscreen -and $el.Current.IsEnabled) { $target = $el; break }
}
if (-not $target) { throw 'Nie znaleziono pasującego elementu UI.' }
`;
}

async function uiClick(args = {}) {
  if (!args.name && !args.automationId && !args.controlType) throw new Error('Podaj name, automationId albo controlType.');
  const script = `${bootstrap}${findElementScript(args)}
$done = $false
$pattern = $null
if ($target.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { $pattern.Invoke(); $done=$true }
elseif ($target.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) { $pattern.Select(); $done=$true }
elseif ($target.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) { $pattern.Toggle(); $done=$true }
elseif ($target.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) { $pattern.Expand(); $done=$true }
if (-not $done) {
  $pt = New-Object System.Windows.Point
  if ($target.TryGetClickablePoint([ref]$pt)) {
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RezeMouse { [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y); [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint data,UIntPtr extra); }
'@
    [RezeMouse]::SetCursorPos([int]$pt.X,[int]$pt.Y) | Out-Null
    [RezeMouse]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [RezeMouse]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
    $done=$true
  }
}
if (-not $done) { throw 'Element nie obsługuje kliknięcia.' }
[pscustomobject]@{ ok=$true; name=$target.Current.Name; type=$target.Current.ControlType.ProgrammaticName.Replace('ControlType.','') } | ConvertTo-Json -Compress
`;
  return JSON.parse(await runPs(script));
}

async function uiSetText(args = {}) {
  if (!args.name && !args.automationId && !args.controlType) throw new Error('Podaj name, automationId albo controlType.');
  const value = psString(args.text || '');
  const script = `${bootstrap}${findElementScript(args)}
$text = ${value}
$pattern = $null
if ($target.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern) -and -not $pattern.Current.IsReadOnly) {
  $pattern.SetValue($text)
} else {
  $target.SetFocus(); Start-Sleep -Milliseconds 80
  [System.Windows.Forms.SendKeys]::SendWait('^a')
  [System.Windows.Forms.SendKeys]::SendWait($text.Replace('{','{{}').Replace('}','{}}'))
}
[pscustomobject]@{ ok=$true; name=$target.Current.Name } | ConvertTo-Json -Compress
`;
  return JSON.parse(await runPs(script));
}

module.exports = { uiSnapshot, uiFocusWindow, uiClick, uiSetText };
