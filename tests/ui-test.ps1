# UI test: serves the app, opens it in an invisible Edge and draws with real (synthesized) mouse
# and keyboard input: rectangle, ellipse, star, pen path, group, align, unite, text. Then exports
# SVG, PDF, PNG, DXF and .vdraw through the download fallback, re-opens the .vdraw and the SVG,
# checks the DXF is to scale, opens sample DXFs, and takes screenshots.
#   powershell -ExecutionPolicy Bypass -File tests\ui-test.ps1 [-Out tests\out\ui]
param(
    [string]$Out = (Join-Path $PSScriptRoot 'out\ui'),
    [int]$Port = 8132
)
$root = Split-Path $PSScriptRoot
. (Join-Path $root 'tools\cdp.ps1')
New-Item -ItemType Directory -Force $Out | Out-Null
$saved = Join-Path $Out 'saved'
New-Item -ItemType Directory -Force $saved | Out-Null
Get-ChildItem $saved -File | Remove-Item

$server = Start-Job -ScriptBlock { param($s, $p, $o) & powershell -ExecutionPolicy Bypass -File $s -Port $p -Out $o } -ArgumentList (Join-Path $root 'tools\serve.ps1'), $Port, $Out
Start-Sleep 2
$e = Start-Cdp -Width 1440 -Height 900
$log = New-Object System.Collections.Generic.List[string]
$fails = 0
function Check([string]$what, [bool]$ok, [string]$detail = '') {
    $line = "$(if ($ok) { 'PASS' } else { 'FAIL' })  $what$(if ($detail) { "  ($detail)" })"
    $script:log.Add($line); Write-Host $line
    if (-not $ok) { $script:fails++ }
}

# ---- input helpers (real browser input events, inside the headless Edge only)
function Mouse([string]$type, [double]$x, [double]$y, [int]$mods = 0, [int]$clicks = 1) {
    $p = @{ type = $type; x = $x; y = $y; modifiers = $mods; button = 'left'; clickCount = $clicks }
    if ($type -eq 'mouseMoved') { $p.buttons = $script:held }
    Invoke-Cdp $e 'Input.dispatchMouseEvent' $p | Out-Null
}
$script:held = 0
function Press([double]$x, [double]$y, [int]$mods = 0) { Mouse 'mouseMoved' $x $y $mods; $script:held = 1; Mouse 'mousePressed' $x $y $mods }
function Release([double]$x, [double]$y, [int]$mods = 0) { Mouse 'mouseReleased' $x $y $mods; $script:held = 0 }
function DragTo($pts, [int]$mods = 0) {
    Press $pts[0][0] $pts[0][1] $mods
    for ($i = 1; $i -lt $pts.Count; $i++) {
        $a = $pts[$i - 1]; $b = $pts[$i]
        for ($k = 1; $k -le 6; $k++) { Mouse 'mouseMoved' ($a[0] + ($b[0] - $a[0]) * $k / 6) ($a[1] + ($b[1] - $a[1]) * $k / 6) $mods }
    }
    $l = $pts[$pts.Count - 1]
    Release $l[0] $l[1] $mods
}
function Click([double]$x, [double]$y, [int]$mods = 0) { Press $x $y $mods; Release $x $y $mods }
# key with modifiers (1 Alt, 2 Ctrl, 8 Shift)
function Key([string]$key, [string]$code, [int]$vk, [int]$mods = 0, [string]$text = '') {
    $d = @{ type = $(if ($text) { 'keyDown' } else { 'rawKeyDown' }); key = $key; code = $code; windowsVirtualKeyCode = $vk; modifiers = $mods }
    if ($text) { $d.text = $text }
    Invoke-Cdp $e 'Input.dispatchKeyEvent' $d | Out-Null
    Invoke-Cdp $e 'Input.dispatchKeyEvent' @{ type = 'keyUp'; key = $key; code = $code; windowsVirtualKeyCode = $vk; modifiers = $mods } | Out-Null
}
# document inches -> page pixels
function P([double]$xin, [double]$yin) {
    $v = Eval-Cdp $e "(() => { const r = document.getElementById('stage-wrap').getBoundingClientRect(); const S = VD.S; return [r.left + S.panX + $xin * 96 * S.zoom, r.top + S.panY + $yin * 96 * S.zoom]; })()"
    return , @([double]$v[0], [double]$v[1])
}
function Count() { Eval-Cdp $e "VD.S.doc.layers.reduce((n, l) => n + l.children.length, 0)" }
function Wait-Downloads([int]$n) { for ($i = 0; $i -lt 60 -and @(Get-ChildItem $saved -File | Where-Object { $_.Extension -ne '.crdownload' }).Count -lt $n; $i++) { Start-Sleep -Milliseconds 300 } }

try {
    Invoke-Cdp $e 'Page.navigate' @{ url = "http://localhost:$Port/" } | Out-Null
    Start-Sleep 2
    Invoke-Cdp $e 'Page.setDownloadBehavior' @{ behavior = 'allow'; downloadPath = $saved } | Out-Null
    Eval-Cdp $e "window.showSaveFilePicker = undefined; VD.settings.snapGrid = true; VD.settings.snapPoints = false; VD.S.fileName = 'ui-test'; 1" | Out-Null
    Check 'app loaded' ((Eval-Cdp $e "typeof VD") -eq 'object')

    # ---- rectangle 2 x 1 in, with the M key and snapping to the 1/4 in grid
    Key 'm' 'KeyM' 77 0 'm'
    Check 'M selects the rectangle tool' ((Eval-Cdp $e "VD.S.tool") -eq 'rect')
    $a = P 1 1; $b = P 3 2
    DragTo @($a, $b)
    $box = Eval-Cdp $e "(() => { const o = VD.S.doc.layers[0].children.at(-1); return JSON.stringify(o.subpaths[0].nodes.map(n => [n.x/96, n.y/96])); })()"
    Check 'rectangle 2 x 1 in drawn' ($box -eq '[[1,1],[3,1],[3,2],[1,2]]') $box

    # ---- second rectangle and an overlapping ellipse for Unite
    DragTo @((P 1 3), (P 3 4.5))
    Key 'l' 'KeyL' 76 0 'l'
    DragTo @((P 2.5 3.25), (P 4 4.75))
    # ---- star (center drag) and a pen path with a curve
    Eval-Cdp $e "VD.setTool('star'); 1" | Out-Null
    DragTo @((P 6 2), (P 6 1))
    Key 'p' 'KeyP' 80 0 'p'
    Click (P 1 6)[0] (P 1 6)[1]
    DragTo @((P 3 6), (P 4 5.5))
    Click (P 5 7)[0] (P 5 7)[1]
    Key 'Enter' 'Enter' 13
    $n = Count
    Check 'five objects drawn (2 rectangles, ellipse, star, pen path)' ($n -eq 5) "count $n"
    $pen = Eval-Cdp $e "JSON.stringify(VD.S.doc.layers[0].children.at(-1).subpaths[0].nodes.map(n => !!n.out))"
    Check 'pen path has a curved middle anchor' ($pen -eq '[false,true,false]') $pen

    # ---- selection tool: marquee the second rectangle + ellipse, Unite
    Key 'v' 'KeyV' 86 0 'v'
    Eval-Cdp $e "VD.S.sel = []; 1" | Out-Null
    DragTo @((P 0.5 2.9), (P 4.2 4.9))
    $sel = Eval-Cdp $e "VD.S.sel.length"
    Check 'marquee selects rectangle and ellipse' ($sel -eq 2) "selected $sel"
    Eval-Cdp $e "document.querySelector('[title^=""Unite""]').click(); 1" | Out-Null
    $u = Eval-Cdp $e "(() => { const o = VD.S.doc.layers[0].children.find(o => o.name === 'Unite'); return o ? o.subpaths.length + ':' + o.subpaths[0].nodes.length : 'none'; })()"
    Check 'Unite made one shape' ($u -match '^1:\d+$') $u
    Check 'object count after unite' ((Count) -eq 4) "count $(Count)"

    # ---- group star + pen path with Ctrl+G (Shift-click to add), then align to artboard center
    $star = P 6 1.6
    Click $star[0] $star[1]
    $penPt = P 1 6
    Click $penPt[0] $penPt[1] 8
    $sel = Eval-Cdp $e "VD.S.sel.length"
    Key 'g' 'KeyG' 71 2
    $g = Eval-Cdp $e "(() => { const o = VD.S.doc.layers[0].children.find(o => o.type === 'group'); return o ? o.children.length : 0; })()"
    Check 'Ctrl+G groups the star and the pen path' ($g -eq 2) "selected $sel, group of $g"
    Eval-Cdp $e "VD.settings.alignTo = 'artboard'; document.querySelector('[title=""Align horizontal centers""]').click(); 1" | Out-Null
    $cx = Eval-Cdp $e "(() => { const o = VD.S.doc.layers[0].children.find(o => o.type === 'group'); const b = VD.bounds(o); return (b.x + b.w / 2) / 96; })()"
    Check 'group centered on the artboard' ([Math]::Abs($cx - 4.25) -lt 1e-6) "center x $cx in"

    # ---- text
    Key 't' 'KeyT' 84 0 't'
    $tp = P 1 9
    Click $tp[0] $tp[1]
    Start-Sleep -Milliseconds 300
    Invoke-Cdp $e 'Input.insertText' @{ text = 'BADGER 11 ga' } | Out-Null
    Key 'Escape' 'Escape' 27
    $t = Eval-Cdp $e "(VD.S.doc.layers[0].children.find(o => o.type === 'text') || {}).text"
    Check 'text typed' ($t -eq 'BADGER 11 ga') $t
    Key 'v' 'KeyV' 86 0 'v'
    Shot-Cdp $e (Join-Path $Out '1-drawing.png')

    # ---- undo / redo
    $before = Count
    Key 'z' 'KeyZ' 90 2
    $mid = Count
    Key 'z' 'KeyZ' 90 10
    Check 'undo removes the text, redo brings it back' ($mid -eq $before - 1 -and (Count) -eq $before) "$before -> $mid -> $(Count)"

    # ---- select the group, show direct selection anchors for the screenshot
    $objs = Count
    Key 'a' 'KeyA' 65 0 'a'
    $node = "(i) => { const o = VD.S.doc.layers[0].children.find(o => o.type === 'group').children[1]; const n = o.subpaths[0].nodes[i];"
    $pp = Eval-Cdp $e "($node const r = document.getElementById('stage-wrap').getBoundingClientRect(); return [r.left + VD.S.panX + n.x * VD.S.zoom + 4, r.top + VD.S.panY + n.y * VD.S.zoom]; })(0)"
    Click $pp[0] $pp[1]
    $mid = Eval-Cdp $e "($node const r = document.getElementById('stage-wrap').getBoundingClientRect(); return [r.left + VD.S.panX + n.x * VD.S.zoom, r.top + VD.S.panY + n.y * VD.S.zoom]; })(1)"
    Click $mid[0] $mid[1]
    $an = Eval-Cdp $e "[...VD.S.anchors.values()].reduce((n, s) => n + s.size, 0)"
    Check 'direct selection picks one anchor of the pen path' ($an -eq 1) "$an"
    Shot-Cdp $e (Join-Path $Out '2-direct-selection.png')
    Eval-Cdp $e "VD.setTool('select'); VD.S.sel = []; VD.renderNow(); 1" | Out-Null

    # ---- exports through the menu commands (download fallback)
    foreach ($c in 'save', 'exportSvg', 'exportPdf', 'exportDxf') { Eval-Cdp $e "VD.COMMANDS.$c(); 1" | Out-Null; Start-Sleep -Milliseconds 800 }
    Eval-Cdp $e "VD.COMMANDS.exportPng(); 1" | Out-Null
    Start-Sleep -Milliseconds 500
    Eval-Cdp $e "document.getElementById('f-dpi').value = '150'; document.querySelector('#modal-form .btn.primary').click(); 1" | Out-Null
    Wait-Downloads 5
    Start-Sleep 1
    $files = Get-ChildItem $saved -File
    $log.Add('saved: ' + (($files | ForEach-Object { "$($_.Name) ($([Math]::Round($_.Length / 1KB, 1)) KB)" }) -join ', '))
    foreach ($x in 'vdraw', 'svg', 'pdf', 'dxf', 'png') { Check "exported .$x" ([bool]($files | Where-Object { $_.Extension -eq ".$x" -and $_.Length -gt 100 })) }
    $pdf = [IO.File]::ReadAllBytes((Join-Path $saved 'ui-test.pdf'))
    Check 'PDF starts with %PDF and has no embedded raster of the page' ([Text.Encoding]::ASCII.GetString($pdf, 0, 5) -eq '%PDF-' -and -not ([Text.Encoding]::ASCII.GetString($pdf) -match '/Subtype\s*/Image')) "$($pdf.Length) bytes"
    $png = [IO.File]::ReadAllBytes((Join-Path $saved 'ui-test.png'))
    $pw = ([int]$png[16] -shl 24) + ([int]$png[17] -shl 16) + ([int]$png[18] -shl 8) + $png[19]
    $ph = ([int]$png[20] -shl 24) + ([int]$png[21] -shl 16) + ([int]$png[22] -shl 8) + $png[23]
    Check 'PNG is Letter at 150 dpi (1275 x 1650)' ($pw -eq 1275 -and $ph -eq 1650) "$pw x $ph"

    # ---- re-open the .vdraw and the SVG; compare object counts
    $base = "tests/out/ui/saved"
    $leaf = "(d) => { let n = 0; const w = (l) => l.forEach(o => { if (o.children) w(o.children); else n++; }); w(d.layers); return n; }"
    $orig = Eval-Cdp $e "($leaf)(VD.S.doc)"
    $re = Eval-Cdp $e "(async () => { const b = await (await fetch('$base/ui-test.vdraw')).blob(); VD.S.dirty = false; await VD.openFile(new File([b], 'ui-test.vdraw')); return ($leaf)(VD.S.doc); })()"
    Check '.vdraw re-opens with the same objects' ($re -eq $orig) "$orig vs $re"
    $re2 = Eval-Cdp $e "(async () => { const b = await (await fetch('$base/ui-test.svg')).blob(); VD.S.dirty = false; await VD.openFile(new File([b], 'ui-test.svg')); return ($leaf)(VD.S.doc) + ' ' + VD.S.doc.width / 96 + 'x' + VD.S.doc.height / 96; })()"
    Check 'SVG re-opens with the same objects and page size' ($re2 -eq "$orig 8.5x11") "$orig vs $re2"
    Eval-Cdp $e "VD.renderNow(); 1" | Out-Null
    Shot-Cdp $e (Join-Path $Out '3-svg-reopened.png')

    # ---- DXF to scale: re-read with the DXF reader and find the 2 x 1 in rectangle
    $dxf = Eval-Cdp $e "(async () => { const t = new Uint8Array(await (await fetch('$base/ui-test.dxf')).arrayBuffer()); const r = VD.importDxf(t, 'in', { join: false }); const out = []; for (const l of r.layers) for (const o of l.children) if (o.type === 'path') { const xs = o.subpaths[0].nodes.map(n => n.x), ys = o.subpaths[0].nodes.map(n => n.y); out.push(((Math.max(...xs) - Math.min(...xs)) / 96).toFixed(4) + 'x' + ((Math.max(...ys) - Math.min(...ys)) / 96).toFixed(4)); } return r.unitName + ' ' + out.join(' '); })()"
    Check 'DXF says inches and has the 2 x 1 in rectangle' ($dxf -match '^in ' -and $dxf -match '2\.0000x1\.0000') $dxf
    $txt = Get-Content (Join-Path $saved 'ui-test.dxf') -Raw
    Check 'DXF has $INSUNITS 1 and closed polylines' ($txt -match '\$INSUNITS\r\n70\r\n1\r\n' -and $txt -match 'POLYLINE[\s\S]*?\r\n70\r\n1\r\n') ''

    # ---- sample DXFs (seb's, copied to tests\samples)
    foreach ($f in Get-ChildItem (Join-Path $PSScriptRoot 'samples') -Filter *.dxf -ErrorAction SilentlyContinue) {
        $name = $f.Name -replace "'", "\'"
        $r = Eval-Cdp $e "(async () => { const b = await (await fetch('tests/samples/' + encodeURIComponent('$name'))).blob(); VD.S.dirty = false; await VD.openFile(new File([b], '$name')); VD.renderNow(); const objs = VD.S.doc.layers.flatMap(l => l.children); const closed = objs.filter(o => o.type === 'path' && o.subpaths[0].closed).length; return objs.length + ' objects, ' + closed + ' closed; ' + document.getElementById('st-msg').textContent; })()"
        Check "opens $($f.Name)" ($r -match '^\d+ objects' -and $r -notmatch "^0 objects") $r
        Start-Sleep -Milliseconds 500
        Shot-Cdp $e (Join-Path $Out ("4-dxf-" + ($f.BaseName -replace '[^\w-]+', '_') + '.png'))
    }

    # ---- menus and dialogs look right
    Eval-Cdp $e "document.querySelectorAll('#menubar button')[3].click(); 1" | Out-Null
    Start-Sleep -Milliseconds 300
    Shot-Cdp $e (Join-Path $Out '5-path-menu.png')
    Eval-Cdp $e "document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); VD.COMMANDS.offset(); 1" | Out-Null
    Start-Sleep -Milliseconds 300
    Eval-Cdp $e "VD.S.sel = [VD.S.doc.layers.flatMap(l => l.children).find(o => o.type === 'path' && o.subpaths[0].closed)?.id].filter(Boolean); VD.COMMANDS.offset(); 1" | Out-Null
    Start-Sleep -Milliseconds 300
    Shot-Cdp $e (Join-Path $Out '6-offset-dialog.png')
    Eval-Cdp $e "document.querySelector('#modal-form .btn.primary').click(); 1" | Out-Null
    Start-Sleep -Milliseconds 300
    $off = Eval-Cdp $e "VD.S.doc.layers.flatMap(l => l.children).filter(o => o.name === 'Offset path').length"
    Check 'Offset Path made a new outline' ($off -ge 1) "$off"

    # ================================================================ more tools, on a fresh document
    Eval-Cdp $e "VD.loadDoc(VD.newDocument(11 * 96, 8.5 * 96, 'in'), 'tools', null); VD.settings.snapGrid = true; VD.settings.snapPoints = false; VD.settings.smart = true; VD.setTool('rect'); 1" | Out-Null
    Start-Sleep -Milliseconds 300
    DragTo @((P 1 1), (P 3 2))
    Key 'v' 'KeyV' 86 0 'v'
    $bb = "(() => { const o = VD.S.doc.layers[0].children[IDX]; const b = VD.bounds(o); return [b.x, b.y, b.w, b.h].map(v => +(v / 96).toFixed(4)).join(','); })()"
    # scale with the bottom-right handle, Shift keeps proportions (2 x 1 -> 4 x 2)
    DragTo @((P 3 2), (P 5 2.6)) 8
    $s = Eval-Cdp $e ($bb -replace 'IDX', '0')
    Check 'Shift-drag on a corner handle scales in proportion' ($s -eq '1,1,4,2') $s
    # rotate 90° from just outside the top-right corner (Shift snaps to 15°)
    $c = P 3 2; $tr = P 5.12 0.88
    $r = [Math]::Sqrt([Math]::Pow($tr[0] - $c[0], 2) + [Math]::Pow($tr[1] - $c[1], 2)); $a0 = [Math]::Atan2($tr[1] - $c[1], $tr[0] - $c[0])
    $arc = @(); for ($k = 0; $k -le 10; $k++) { $a = $a0 + [Math]::PI / 2 * $k / 10; $arc += , @(($c[0] + $r * [Math]::Cos($a)), ($c[1] + $r * [Math]::Sin($a))) }
    DragTo $arc 8
    $s = Eval-Cdp $e ($bb -replace 'IDX', '0')
    Check 'rotating 90° from outside a corner turns 4 x 2 into 2 x 4' ($s -eq '2,0,2,4') $s
    # Alt-drag makes a copy; smart guides line its top up with the original's
    Eval-Cdp $e "VD.settings.snapGrid = false; 1" | Out-Null
    DragTo @((P 3 2), (P 5.5 2.03)) 1
    $n = Count
    $s2 = Eval-Cdp $e ($bb -replace 'IDX', '1')
    Check 'Alt-drag copies; smart guide lines up the top edge' ($n -eq 2 -and $s2 -match '^[\d.]+,0,2,4$') "count $n, copy at $s2"
    # nudge right 1/16 in with the arrow key
    $before = Eval-Cdp $e ($bb -replace 'IDX', '1')
    Key 'ArrowRight' 'ArrowRight' 39
    $after = Eval-Cdp $e ($bb -replace 'IDX', '1')
    Check 'arrow key nudges 1/16 in' ([Math]::Abs([double]($after.Split(',')[0]) - [double]($before.Split(',')[0]) - 0.0625) -lt 1e-4) "$before -> $after"
    # pencil
    Key 'n' 'KeyN' 78 0 'n'
    $zig = @(); for ($k = 0; $k -le 40; $k++) { $zig += , (P (1 + $k * 0.12) (6 + 0.5 * [Math]::Sin($k / 3))) }
    DragTo $zig
    $pn = Eval-Cdp $e "(() => { const o = VD.S.doc.layers[0].children.at(-1); return o.name + ' ' + o.subpaths[0].nodes.length + ' ' + o.subpaths[0].nodes.some(n => n.out); })()"
    Check 'pencil draws a smoothed curve with few anchors' ($pn -match '^Pencil (\d+) true$' -and [int]$Matches[1] -lt 20) $pn
    # eyedropper: paint the first rectangle red, pick it up onto the pencil line
    Eval-Cdp $e "VD.S.doc.layers[0].children[0].style.stroke = '#dc2626'; VD.S.doc.layers[0].children[0].style.strokeWidth = 4; VD.renderNow(); 1" | Out-Null
    Key 'i' 'KeyI' 73 0 'i'
    $mid = Eval-Cdp $e "(() => { const b = VD.bounds(VD.S.doc.layers[0].children[0]); const r = document.getElementById('stage-wrap').getBoundingClientRect(); return [r.left + VD.S.panX + (b.x + b.w / 2) * VD.S.zoom, r.top + VD.S.panY + (b.y + b.h / 2) * VD.S.zoom]; })()"
    Click $mid[0] $mid[1]
    $ed = Eval-Cdp $e "VD.S.doc.layers[0].children.at(-1).style.stroke + ' ' + VD.S.doc.layers[0].children.at(-1).style.strokeWidth"
    Check 'eyedropper copies stroke color and weight' ($ed -eq '#dc2626 4') $ed
    # hand and zoom
    Key 'h' 'KeyH' 72 0 'h'
    $px = Eval-Cdp $e "VD.S.panX"
    DragTo @((P 6 4), (P 7 4))
    $px2 = Eval-Cdp $e "VD.S.panX"
    $z = Eval-Cdp $e "VD.S.zoom"
    $wp = P 6 4
    Invoke-Cdp $e 'Input.dispatchMouseEvent' @{ type = 'mouseWheel'; x = $wp[0]; y = $wp[1]; deltaX = 0; deltaY = -300; modifiers = 2 } | Out-Null
    Start-Sleep -Milliseconds 200
    $z2 = Eval-Cdp $e "VD.S.zoom"
    Check 'hand pans and Ctrl+wheel zooms' ($px2 -gt $px -and $z2 -gt $z) "pan $px -> $px2, zoom $z -> $z2"
    Eval-Cdp $e "VD.COMMANDS.fit(); 1" | Out-Null
    # copy / paste (the app's own clipboard; the system clipboard is never touched here)
    Eval-Cdp $e "VD.setTool('select'); VD.S.sel = [VD.S.doc.layers[0].children[0].id]; VD.ops.copy(); VD.ops.paste(); 1" | Out-Null
    Check 'copy and paste' ((Count) -eq 4) "count $(Count)"
    # pathfinder: minus front, intersect, exclude on two overlapping squares (areas in sq in)
    $area = "(o) => { let a = 0; for (const sp of o.subpaths) { const n = sp.nodes; for (let i = 0; i < n.length; i++) { const p = n[i], q = n[(i + 1) % n.length]; a += p.x * q.y - q.x * p.y; } } return Math.abs(a / 2) / 9216; }"
    foreach ($op in @(@('minus', 3), @('intersect', 1), @('exclude', 6))) {
        $res = Eval-Cdp $e "(() => { const R = (x, y) => ({ type: 'path', id: 'q' + Math.random().toString(36).slice(2), name: 'sq', style: { fill: '#888', stroke: null, strokeWidth: 0 }, subpaths: [{ closed: true, nodes: [[x, y], [x + 192, y], [x + 192, y + 192], [x, y + 192]].map(([x, y]) => ({ x, y, in: null, out: null })) }] }); const a = R(96, 480), b = R(192, 576); VD.S.doc.layers[0].children.push(a, b); VD.S.sel = [a.id, b.id]; VD.ops.pathfinder('$($op[0])'); const o = VD.S.doc.layers[0].children.at(-1); const ar = ($area)(o); VD.ops.deleteSel(); return ar.toFixed(4); })()"
        Check "pathfinder $($op[0]) area" ([Math]::Abs([double]$res - $op[1]) -lt 1e-3) "$res sq in, expected $($op[1])"
    }
    # offset path with miter corners: 2 x 1 grows to 2.125 x 1.125
    $res = Eval-Cdp $e "(() => { const o = { type: 'path', id: 'off1', name: 'r', style: { fill: null, stroke: '#000', strokeWidth: 1 }, subpaths: [{ closed: true, nodes: [[96, 96], [288, 96], [288, 192], [96, 192]].map(([x, y]) => ({ x, y, in: null, out: null })) }] }; VD.S.doc.layers[0].children.push(o); VD.S.sel = ['off1']; VD.ops.offset(6, 'miter'); const b = VD.bounds(VD.S.doc.layers[0].children.find(x => x.name === 'Offset path')); return [b.w, b.h].map(v => (v / 96).toFixed(4)).join('x'); })()"
    Check 'offset path 1/16 in, miter corners' ($res -eq '2.1250x1.1250') $res
    # gradient fill and a placed picture, then check the PDF has a shading, an image and vector paths
    $res = Eval-Cdp $e "(async () => { const c = document.createElement('canvas'); c.width = 64; c.height = 48; const g = c.getContext('2d'); g.fillStyle = '#d25800'; g.fillRect(0, 0, 64, 48); g.fillStyle = '#fff'; g.fillRect(16, 12, 32, 24); const blob = await new Promise(r => c.toBlob(r, 'image/png')); await VD.placeFiles([new File([blob], 'pic.png', { type: 'image/png' })]); const r = VD.S.doc.layers[0].children[0]; r.style.fill = { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#d25800' }, { offset: 1, color: '#1b1d20' }] }; VD.renderNow(); const bytes = await VD.exportPdf(VD.S.doc); const { PDFDocument, PDFName } = await import('./vendor/pdf-lib.esm.min.js'); const pdf = await PDFDocument.load(bytes); const res = pdf.getPage(0).node.Resources(); const k = (n) => { const d = res.lookup(PDFName.of(n)); return d ? d.keys().length : 0; }; const sz = pdf.getPage(0).getSize(); return 'shadings ' + k('Shading') + ' images ' + k('XObject') + ' page ' + sz.width + 'x' + sz.height; })()"
    Check 'PDF has the gradient as a shading, the picture, and the page is 11 x 8.5 in' ($res -eq 'shadings 1 images 1 page 792x612') $res
    # SVG with nested transforms and an arc command
    $res = Eval-Cdp $e "(() => { const r = VD.importSvg('<svg xmlns=""http://www.w3.org/2000/svg"" width=""4in"" height=""2in"" viewBox=""0 0 400 200""><g transform=""translate(100 100) scale(2)""><rect x=""-10"" y=""-10"" width=""20"" height=""20"" fill=""red""/></g><path d=""M200 100 a50 50 0 0 1 100 0"" fill=""none"" stroke=""#00f"" stroke-width=""4""/></svg>'); const b = r.objects.map(o => VD.bounds(o)).map(b => [b.x, b.y, b.w, b.h].map(v => +v.toFixed(3)).join(',')); return r.width + 'x' + r.height + ' ' + b.join(' ') + ' sw ' + r.objects[1].style.strokeWidth; })()"
    Check 'SVG import: units, nested transforms and arcs' ($res -eq '384x192 76.8,76.8,38.4,38.4 192,48,96,48 sw 3.84') $res
    # layers: a new layer, move the picture to it, hide it
    Eval-Cdp $e "document.querySelector('[title=""New layer""]').click(); VD.S.sel = [VD.S.doc.layers[0].children.find(o => o.type === 'image').id]; document.querySelector('[title=""Move the selection to the highlighted layer""]').click(); 1" | Out-Null
    $res = Eval-Cdp $e "VD.S.doc.layers.map(l => l.name + ':' + l.children.map(o => o.type).join('+')).join(' | ')"
    Check 'new layer and move selection to it' ($res -match '\| Layer 2:image$') $res
    Eval-Cdp $e "VD.S.sel = []; VD.renderNow(); 1" | Out-Null
    Start-Sleep -Milliseconds 300
    Shot-Cdp $e (Join-Path $Out '7-tools.png')

    $errs = Eval-Cdp $e "window.__errors.join(' | ')"
    Check 'no script errors' (-not $errs) $errs
}
catch { $log.Add("ERROR: $_"); $fails++ }
finally {
    Stop-Cdp $e
    try { Invoke-RestMethod "http://localhost:$Port/__stop" -TimeoutSec 3 | Out-Null } catch { }
    Stop-Job $server -ErrorAction SilentlyContinue; Remove-Job $server -Force -ErrorAction SilentlyContinue
}
$log | Set-Content (Join-Path $Out 'results.txt') -Encoding utf8
"$fails failure(s)"
